package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const livePingInterval = 60 * time.Second
const liveReadTimeout = 180 * time.Second

var errLiveSuperseded = errors.New("WebSocket connection replaced by another client")

type liveTiming struct{ ping, read time.Duration }

type liveControl struct {
	Protocol    int    `json:"protocol"`
	Compression string `json:"compression"`
	Type        string `json:"type"`
	State       string `json:"state"`
	Interval    int    `json:"interval_seconds"`
	Active      int    `json:"active_seconds"`
	Idle        int    `json:"idle_seconds"`
	Version     int    `json:"version"`
	Sequence    uint64 `json:"sequence"`
	RequestID   string `json:"request_id"`
}

type liveEvent struct {
	control liveControl
	err     error
}

// A control frame and the following connection close must share one FIFO.
// Separate control/error channels let select deliver EOF before an already-read
// acknowledgement or revocation, losing the server's last protocol decision.
func readLiveEvents(ctx context.Context, conn *websocket.Conn, events chan<- liveEvent, readTimeout time.Duration) {
	send := func(event liveEvent) bool {
		select {
		case events <- event:
			return true
		case <-ctx.Done():
			return false
		}
	}
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			send(liveEvent{err: errors.New("WebSocket connection interrupted")})
			return
		}
		if kind != websocket.TextMessage {
			send(liveEvent{err: errors.New("invalid WebSocket control")})
			return
		}
		var message liveControl
		if json.Unmarshal(data, &message) != nil {
			send(liveEvent{err: errors.New("invalid WebSocket control")})
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
		if !send(liveEvent{control: message}) {
			return
		}
	}
}

// Live has one reader and one writer, no upload queue and no retained history.
// Standard WebSocket Ping/Pong frames keep an idle connection alive without
// generating Durable Object application-message events.
func (c *Client) Live(ctx context.Context, collector *Collector, session string, sequence *uint64, once bool) error {
	return c.live(ctx, collector, session, sequence, once, liveTiming{livePingInterval, liveReadTimeout})
}

func (c *Client) live(ctx context.Context, collector *Collector, session string, sequence *uint64, once bool, timing liveTiming) error {
	u, err := url.Parse(strings.TrimRight(c.config.Server, "/") + "/v1/live")
	if err != nil {
		return errors.New("invalid WebSocket endpoint")
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	h := make(http.Header)
	proof := &http.Request{Method: http.MethodGet, URL: u, Header: h}
	if err := c.authorizeRequest(proof, nil); err != nil {
		return err
	}
	h.Set("User-Agent", "spider-watch/2")
	host := collector.Host()
	if !validAgentVersion(host.Version) {
		return errors.New("invalid agent version")
	}
	h.Set("X-Monitor-Agent-Version", host.Version)
	if host.Revision != "" {
		if !validBuildRevision(host.Revision) {
			return errors.New("invalid agent build revision")
		}
		h.Set("X-Monitor-Agent-Revision", host.Revision)
	}
	if c.config.Access.ClientID != "" {
		h.Set("CF-Access-Client-Id", c.config.Access.ClientID)
		h.Set("CF-Access-Client-Secret", c.config.Access.ClientSecret)
	}
	dialer := websocket.Dialer{NetDialContext: c.transport.DialContext,
		TLSClientConfig: c.websocketTLS, HandshakeTimeout: time.Duration(c.config.Timeout) * time.Second,
		ReadBufferSize: 1024, WriteBufferSize: 1024, EnableCompression: false}
	c.Close()
	conn, response, err := dialer.DialContext(ctx, u.String(), h)
	if err != nil {
		if response != nil {
			data, _ := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes))
			response.Body.Close()
			var control ControlResponse
			if json.Unmarshal(data, &control) == nil && (control.State == "revoked" || control.Code == "revoked") {
				return ErrRevoked
			}
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("WebSocket connection failed") // Do not expose credentials or raw URLs.
	}
	conn.SetReadLimit(MaxResponseBytes)
	readCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	var updateDone chan remoteUpdateAck
	var updatingID string
	defer func() {
		cancel()
		conn.Close()
		<-done
		if updateDone != nil {
			c.remoteUpdates.remember(<-updateDone)
		}
	}()
	events := make(chan liveEvent, 4)
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(timing.read)) })
	_ = conn.SetReadDeadline(time.Now().Add(time.Duration(c.config.Timeout) * time.Second))
	go func() {
		defer close(done)
		readLiveEvents(readCtx, conn, events, timing.read)
	}()
	ping := time.NewTicker(timing.ping)
	defer ping.Stop()
	// A config frame is mandatory before collecting or sending metrics.
	timer := time.NewTimer(time.Duration(c.config.Timeout) * time.Second)
	defer timer.Stop()
	configured := false
	protocol := 1
	helloSent, helloAcknowledged := false, false
	compress := false
	var compressor reportCompressor
	var encoder reportEncoder
	interval := time.Duration(c.config.Interval) * time.Second
	version := 0
	var lastSent time.Time
	var awaiting uint64
	var ackDeadline time.Time
	healthy := false
	writeUpdateAck := func(ack remoteUpdateAck) error {
		_ = conn.SetWriteDeadline(time.Now().Add(time.Duration(c.config.Timeout) * time.Second))
		if conn.WriteJSON(ack) != nil {
			return errors.New("WebSocket update acknowledgement failed")
		}
		return nil
	}
	reset := func(delay time.Duration) {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		if delay < 0 {
			delay = 0
		}
		timer.Reset(delay)
	}
	reschedule := func() {
		delay := time.Until(lastSent.Add(interval))
		if awaiting != 0 && time.Until(ackDeadline) < delay {
			delay = time.Until(ackDeadline)
		}
		reset(delay)
	}
	for {
		select {
		case <-ctx.Done():
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "shutdown"), time.Now().Add(time.Second))
			return ctx.Err()
		case ack := <-updateDone:
			updateDone, updatingID = nil, ""
			c.remoteUpdates.remember(ack)
			if err := writeUpdateAck(ack); err != nil {
				return err
			}
		case event := <-events:
			if event.err != nil {
				return event.err
			}
			control := event.control
			switch control.Type {
			case "hello_ack":
				if protocol != 2 || !helloSent || helloAcknowledged {
					return errors.New("unexpected WebSocket hello acknowledgement")
				}
				helloAcknowledged = true
				reschedule()
			case "revoked":
				return ErrRevoked
			case "superseded":
				return errLiveSuperseded
			case "access_expired":
				return errors.New("WebSocket authorization expired")
			case "update":
				if protocol != 2 || !helloSent || !validUpdateRequestID(control.RequestID) {
					return errors.New("invalid WebSocket update request")
				}
				if control.RequestID == updatingID {
					continue
				}
				if ack, found := c.remoteUpdates.find(control.RequestID); found {
					if err := writeUpdateAck(ack); err != nil {
						return err
					}
					continue
				}
				if updateDone != nil {
					ack := remoteUpdateAck{Type: "update_ack", RequestID: control.RequestID, State: "failed", Code: "update_trigger_failed"}
					c.remoteUpdates.remember(ack)
					if err := writeUpdateAck(ack); err != nil {
						return err
					}
					continue
				}
				updatingID = control.RequestID
				updateDone = make(chan remoteUpdateAck, 1)
				go func(id string, result chan<- remoteUpdateAck) {
					triggerCtx, stop := context.WithTimeout(readCtx, 15*time.Second)
					defer stop()
					result <- c.remoteUpdates.start(triggerCtx, c.configPath, id)
				}(updatingID, updateDone)
			case "ack":
				if awaiting != 0 && control.Sequence == awaiting {
					awaiting = 0
					if !healthy {
						healthy = true
						if c.liveHealthy != nil {
							c.liveHealthy()
						}
					}
					if once {
						return nil
					}
					reschedule()
				}
			case "config":
				if control.State != "approved" || control.Active < 2 || control.Active > 300 || control.Idle < 30 || control.Idle > 86400 || control.Idle < control.Active || control.Version < 1 || (control.Interval != control.Active && control.Interval != control.Idle) {
					return errors.New("invalid WebSocket configuration")
				}
				if control.Version < version {
					continue
				}
				version = control.Version
				compress = control.Compression == "gzip"
				if !configured && control.Protocol == 2 {
					protocol = 2
					host.Version = ""
					host.Revision = ""
					_ = conn.SetWriteDeadline(time.Now().Add(time.Duration(c.config.Timeout) * time.Second))
					if conn.WriteJSON(LiveHello{Type: "hello", Protocol: 2, Session: session, UpdateControl: 1, Host: host}) != nil {
						return errors.New("WebSocket hello failed")
					}
					helloSent = true
				}
				next := time.Duration(control.Interval) * time.Second
				if !configured || next != interval {
					interval = next
					configured = true
					if protocol == 2 && !helloAcknowledged {
						reset(time.Duration(c.config.Timeout) * time.Second)
					} else {
						reschedule()
					}
				}
			default:
				return errors.New("unsupported WebSocket control")
			}
		case <-ping.C:
			if awaiting != 0 && time.Now().After(ackDeadline) {
				return errors.New("WebSocket report acknowledgement timed out")
			}
			if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Duration(c.config.Timeout)*time.Second)) != nil {
				return errors.New("WebSocket keepalive failed")
			}
		case now := <-timer.C:
			if !configured {
				return errors.New("WebSocket configuration timed out")
			}
			if protocol == 2 && !helloAcknowledged {
				return errors.New("WebSocket hello acknowledgement timed out")
			}
			if awaiting != 0 {
				if now.After(ackDeadline) {
					return errors.New("WebSocket report acknowledgement timed out")
				}
				reset(time.Until(ackDeadline))
				continue
			}
			*sequence++
			var report any
			metrics := collector.Collect(now)
			if protocol == 2 {
				report = LiveMetrics{Type: "metrics", Sequence: *sequence, Metrics: metrics}
			} else {
				report = ReportRequest{Protocol: ProtocolVersion, NodeID: c.config.NodeID, Session: session,
					Sequence: *sequence, Host: collector.Host(), Metrics: metrics}
			}
			data, err := encoder.encode(report)
			if err != nil || len(data) > MaxRequestBytes {
				return errors.New("WebSocket report exceeds size limit")
			}
			_ = conn.SetWriteDeadline(time.Now().Add(time.Duration(c.config.Timeout) * time.Second))
			kind := websocket.TextMessage
			if compress {
				var compressed bool
				data, compressed, err = compressor.encode(data)
				if err != nil {
					return err
				}
				if compressed {
					kind = websocket.BinaryMessage
				}
			}
			if conn.WriteMessage(kind, data) != nil {
				return errors.New("WebSocket report failed")
			}
			awaiting = *sequence
			ackDeadline = time.Now().Add(time.Duration(c.config.Timeout) * time.Second)
			lastSent = time.Now()
			reschedule()
		}
	}
}
