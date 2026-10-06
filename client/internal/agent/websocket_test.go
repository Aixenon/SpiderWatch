package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestLiveV2SendsVersionOnceAndWaitsForHelloAcknowledgement(t *testing.T) {
	previous := BuildRevision
	BuildRevision = strings.Repeat("b", 40)
	t.Cleanup(func() { BuildRevision = previous })
	var reports atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Monitor-Agent-Version") != "0.4.0" {
			t.Error("version missing from handshake")
		}
		if r.Header.Get("X-Monitor-Agent-Revision") != BuildRevision {
			t.Error("build revision missing from handshake")
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		control := liveTestConfig(30, 1)
		control.Protocol, control.Compression = 2, "gzip"
		_ = conn.WriteJSON(control)
		var hello map[string]json.RawMessage
		if conn.ReadJSON(&hello) != nil {
			t.Error("no hello")
			return
		}
		var host map[string]any
		_ = json.Unmarshal(hello["host"], &host)
		if string(hello["type"]) != `"hello"` || string(hello["protocol"]) != "2" || len(hello["session"]) != 34 || host["hostname"] == nil || host["agent_version"] != nil || host["agent_revision"] != nil {
			t.Error("hello repeats version or lacks stable host metadata")
		}
		// A zero ack must not make --once exit before its first real report.
		_ = conn.WriteJSON(liveControl{Type: "ack", Sequence: 0})
		_ = conn.WriteJSON(liveControl{Type: "hello_ack"})
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Error(err)
			return
		}
		if kind == websocket.BinaryMessage {
			reader, err := gzip.NewReader(bytes.NewReader(data))
			if err != nil {
				t.Error(err)
				return
			}
			data, err = io.ReadAll(reader)
			reader.Close()
			if err != nil {
				t.Error(err)
				return
			}
		}
		var payload map[string]json.RawMessage
		if json.Unmarshal(data, &payload) != nil || len(payload) != 3 || string(payload["type"]) != `"metrics"` || string(payload["sequence"]) != "1" || payload["metrics"] == nil {
			t.Errorf("noncompact metrics: %s", data)
		}
		for _, field := range []string{"host", "node_id", "agent_version", "agent_revision", "session", "protocol"} {
			if payload[field] != nil {
				t.Errorf("repeated metadata %s", field)
			}
		}
		reports.Add(1)
		_ = conn.WriteJSON(liveControl{Type: "ack", Sequence: 1})
	}))
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var sequence uint64
	if err := client.Live(ctx, NewCollector(config, "0.4.0"), strings.Repeat("a", 32), &sequence, true); err != nil {
		t.Fatal(err)
	}
	if reports.Load() != 1 {
		t.Fatal("missing acknowledged metrics")
	}
}

func TestLiveV2DoesNotCollectOrReportWithoutHelloAcknowledgement(t *testing.T) {
	var metrics atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		control := liveTestConfig(30, 1)
		control.Protocol = 2
		_ = conn.WriteJSON(control)
		var hello LiveHello
		if conn.ReadJSON(&hello) != nil {
			return
		}
		if _, _, err = conn.ReadMessage(); err == nil {
			metrics.Add(1)
		}
	}))
	defer client.Close()
	client.config.Timeout = 1
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var sequence uint64
	err := client.Live(ctx, NewCollector(config, "0.4.0"), strings.Repeat("a", 32), &sequence, true)
	if err == nil || !strings.Contains(err.Error(), "hello acknowledgement timed out") || sequence != 0 || metrics.Load() != 0 {
		t.Fatalf("reported before hello ack: %v, sequence=%d", err, sequence)
	}
}

func liveTestConfig(interval, version int) liveControl {
	return liveControl{Type: "config", State: "approved", Active: 2, Idle: 30, Interval: interval, Version: version}
}

func TestRunWebSocketOnceUsesTLSAccessAndAcknowledgement(t *testing.T) {
	var reports atomic.Int32
	var cfg Config
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("CF-Access-Client-Secret") != cfg.Access.ClientSecret || r.Header.Get("X-Monitor-Node-ID") != cfg.NodeID || r.Header.Get("Authorization") != "Bearer "+cfg.DeviceKey {
			t.Error("missing connection credentials")
			w.WriteHeader(401)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/status") {
			_ = json.NewEncoder(w).Encode(ControlResponse{State: "approved", Transport: "websocket", Interval: 30})
			return
		}
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(liveTestConfig(30, 1))
		var report ReportRequest
		if err = conn.ReadJSON(&report); err != nil {
			t.Error(err)
			return
		}
		if report.NodeID != cfg.NodeID || report.Sequence != 1 || report.Metrics.Memory == nil {
			t.Error("invalid live report")
		}
		reports.Add(1)
		_ = conn.WriteJSON(liveControl{Type: "ack", Sequence: report.Sequence})
	}))
	client.Close()
	cfg = config
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := Run(ctx, config, RunOptions{Once: true, Version: "test"}); err != nil {
		t.Fatal(err)
	}
	if reports.Load() != 1 {
		t.Fatal("--once did not wait for exactly one WebSocket acknowledgement")
	}
}

func TestLiveSwitchesIntervalAndCancelsWithoutWaitingForIdleTimer(t *testing.T) {
	times := make(chan time.Time, 2)
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(liveTestConfig(30, 1))
		for i := 0; i < 2; i++ {
			var report ReportRequest
			if conn.ReadJSON(&report) != nil {
				return
			}
			times <- time.Now()
			_ = conn.WriteJSON(liveControl{Type: "ack", Sequence: report.Sequence})
			if i == 0 {
				_ = conn.WriteJSON(liveTestConfig(2, 1))
			} else {
				_ = conn.WriteJSON(liveTestConfig(30, 2))
			}
		}
		if _, _, err := conn.ReadMessage(); err == nil {
			times <- time.Now()
		}
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ended := make(chan error, 1)
	var sequence uint64
	go func() {
		ended <- client.Live(ctx, NewCollector(config, "test"), strings.Repeat("a", 32), &sequence, false)
	}()
	first := <-times
	second := <-times
	if elapsed := second.Sub(first); elapsed < 1500*time.Millisecond || elapsed > 4*time.Second {
		t.Fatalf("active interval=%s", elapsed)
	}
	select {
	case <-times:
		t.Fatal("ignored idle configuration")
	case err := <-ended:
		t.Fatalf("ended early: %v", err)
	case <-time.After(2500 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-ended:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation waited for idle timer")
	}
}

func TestLiveRevocationPushAndRevokedReconnectStopAgent(t *testing.T) {
	for _, push := range []bool{false, true} {
		t.Run(map[bool]string{false: "reconnect", true: "push"}[push], func(t *testing.T) {
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !push {
					w.WriteHeader(403)
					_ = json.NewEncoder(w).Encode(ControlResponse{State: "revoked", Code: "revoked"})
					return
				}
				upgrader := websocket.Upgrader{}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				_ = conn.WriteJSON(liveControl{Type: "revoked", State: "revoked"})
				_, _, _ = conn.ReadMessage()
			}))
			var sequence uint64
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := client.Live(ctx, NewCollector(config, "test"), strings.Repeat("a", 32), &sequence, false); !errors.Is(err, ErrRevoked) {
				t.Fatal(err)
			}
		})
	}
}

func TestLiveBoundsControlsAndNeverFollowsCredentialRedirect(t *testing.T) {
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1) }))
	defer target.Close()
	for _, large := range []bool{false, true} {
		t.Run(map[bool]string{false: "redirect", true: "oversized-control"}[large], func(t *testing.T) {
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !large {
					http.Redirect(w, r, target.URL, 302)
					return
				}
				upgrader := websocket.Upgrader{}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				_ = conn.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("x", MaxResponseBytes+1)))
				_, _, _ = conn.ReadMessage()
			}))
			var sequence uint64
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := client.Live(ctx, NewCollector(config, "test"), strings.Repeat("a", 32), &sequence, true); err == nil {
				t.Fatal("invalid connection accepted")
			}
		})
	}
	if forwarded.Load() != 0 {
		t.Fatal("forwarded fleet credentials across redirect")
	}
}

func TestLiveLostAcknowledgementTimesOutDuringLongIdleInterval(t *testing.T) {
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(liveTestConfig(30, 1))
		_, _, _ = conn.ReadMessage() // Deliberately omit the report acknowledgement.
		_, _, _ = conn.ReadMessage()
	}))
	client.config.Timeout = 1
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var sequence uint64
	err := client.Live(ctx, NewCollector(config, "test"), strings.Repeat("a", 32), &sequence, false)
	if err == nil || !strings.Contains(err.Error(), "acknowledgement timed out") {
		t.Fatalf("idle acknowledgement timeout: %v", err)
	}
}
