package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestLiveRemoteUpdateDoesNotBlockMetricsAndDeduplicatesReconnects(t *testing.T) {
	const id = "0123456789abcdef0123456789abcdef"
	started, release, healthy := make(chan struct{}), make(chan struct{}), make(chan struct{}, 2)
	var triggers, connections atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection := connections.Add(1)
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		cfg := liveTestConfig(30, 1)
		cfg.Protocol = 2
		_ = conn.WriteJSON(cfg)
		var hello LiveHello
		if conn.ReadJSON(&hello) != nil {
			return
		}
		if hello.UpdateControl != 1 {
			t.Error("missing remote update capability")
		}
		_ = conn.WriteJSON(liveControl{Type: "hello_ack"})
		_ = conn.WriteJSON(liveControl{Type: "update", RequestID: id})
		if connection == 1 {
			_ = conn.WriteJSON(liveControl{Type: "update", RequestID: id})
		}
		gotAck, gotMetric := false, false
		for !gotAck || !gotMetric {
			var message struct {
				Type      string `json:"type"`
				Sequence  uint64 `json:"sequence"`
				RequestID string `json:"request_id"`
				State     string `json:"state"`
			}
			if conn.ReadJSON(&message) != nil {
				return
			}
			switch message.Type {
			case "metrics":
				gotMetric = true
				_ = conn.WriteJSON(liveControl{Type: "ack", Sequence: message.Sequence})
				if connection == 1 {
					select {
					case <-started:
					case <-time.After(time.Second):
						t.Error("remote trigger not started")
					}
					select {
					case <-healthy:
					case <-time.After(time.Second):
						t.Error("trigger blocked metric acknowledgement")
					}
					close(release)
				}
			case "update_ack":
				if message.RequestID != id || message.State != "accepted" {
					t.Errorf("bad update ack: %+v", message)
				}
				gotAck = true
			default:
				t.Error("unexpected client message")
			}
		}
		_ = conn.WriteJSON(liveControl{Type: "revoked"})
	}))
	client.configPath = "installed-config"
	client.liveHealthy = func() { healthy <- struct{}{} }
	client.remoteUpdates.trigger = func(ctx context.Context, path string) error {
		if path != "installed-config" {
			t.Error("config path changed")
		}
		triggers.Add(1)
		close(started)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var sequence uint64
	for i := 0; i < 2; i++ {
		if err := client.Live(ctx, NewCollector(config, "0.7.2"), strings.Repeat("b", 32), &sequence, false); !errors.Is(err, ErrRevoked) {
			t.Fatalf("session %d: %v", i, err)
		}
	}
	if triggers.Load() != 1 || sequence != 2 {
		t.Fatalf("triggers=%d metric sequence=%d", triggers.Load(), sequence)
	}
}

func TestLiveRemoteUpdateRejectsMalformedIDsAndReportsMissingBridge(t *testing.T) {
	for _, id := range []string{"", strings.Repeat("A", 32), "../../execute", strings.Repeat("a", 33), strings.Repeat("a", 32)} {
		t.Run("id-"+id, func(t *testing.T) {
			valid := validUpdateRequestID(id)
			var ackSeen atomic.Bool
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				cfg := liveTestConfig(30, 1)
				cfg.Protocol = 2
				_ = conn.WriteJSON(cfg)
				var hello LiveHello
				if conn.ReadJSON(&hello) != nil {
					return
				}
				_ = conn.WriteJSON(liveControl{Type: "hello_ack"})
				_ = conn.WriteJSON(liveControl{Type: "update", RequestID: id})
				for {
					var message map[string]json.RawMessage
					if conn.ReadJSON(&message) != nil {
						return
					}
					if string(message["type"]) == `"update_ack"` {
						ackSeen.Store(true)
						if string(message["state"]) != `"failed"` || string(message["code"]) != `"update_trigger_failed"` {
							t.Error("missing bridge acknowledged as accepted")
						}
						_ = conn.WriteJSON(liveControl{Type: "revoked"})
						return
					}
				}
			}))
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			var sequence uint64
			err := client.Live(ctx, NewCollector(config, "0.7.2"), strings.Repeat("b", 32), &sequence, false)
			if err == nil || ackSeen.Load() != valid {
				t.Fatalf("ack=%v error=%v", ackSeen.Load(), err)
			}
		})
	}
}

func TestRemoteUpdateReplayStorageIsBounded(t *testing.T) {
	var controls remoteUpdateControl
	for i := 0; i < 1000; i++ {
		controls.remember(remoteUpdateAck{RequestID: strings.Repeat("a", 31) + string(rune('0'+i%10)), State: "accepted"})
	}
	if len(controls.recent) != 16 || controls.next >= len(controls.recent) {
		t.Fatal("unbounded update replay window")
	}
}
