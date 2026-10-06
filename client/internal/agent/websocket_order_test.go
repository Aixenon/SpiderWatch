package agent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Delay the consumer until the reader has also observed the terminal event.
// This deterministically exercises the scheduling state that made independent
// control/error channels lose an acknowledged report or a revocation.
func TestLiveReaderPreservesControlsBeforeTerminalEvent(t *testing.T) {
	for _, terminal := range []string{"close", "binary", "invalid-json"} {
		t.Run(terminal, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
				if err := conn.WriteJSON(liveControl{Type: "ack", Sequence: 7}); err != nil {
					t.Error(err)
					return
				}
				if err := conn.WriteJSON(liveControl{Type: "revoked"}); err != nil {
					t.Error(err)
					return
				}
				switch terminal {
				case "binary":
					_ = conn.WriteMessage(websocket.BinaryMessage, []byte("invalid"))
				case "invalid-json":
					_ = conn.WriteMessage(websocket.TextMessage, []byte("{"))
				}
			}))
			defer server.Close()
			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			events, done := make(chan liveEvent, 4), make(chan struct{})
			go func() { defer close(done); readLiveEvents(ctx, conn, events) }()
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("reader did not finish after terminal frame")
			}
			if len(events) != 3 {
				t.Fatalf("received %d events, want two controls and a terminal event", len(events))
			}
			first, second, last := <-events, <-events, <-events
			if first.err != nil || first.control.Type != "ack" || first.control.Sequence != 7 || second.err != nil || second.control.Type != "revoked" || last.err == nil {
				t.Fatalf("wire event order changed: %+v %+v %+v", first, second, last)
			}
		})
	}
}

func TestLiveOnceRequiresMatchingAckBeforeImmediateClose(t *testing.T) {
	for _, protocol := range []int{1, 2} {
		for _, terminal := range []string{"ack", "wrong-ack", "revoked", "no-ack"} {
			t.Run(fmt.Sprintf("v%d/%s", protocol, terminal), func(t *testing.T) {
				client, cfg, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
					if err != nil {
						t.Error(err)
						return
					}
					defer conn.Close()
					config := liveTestConfig(30, 1)
					config.Protocol = protocol
					if err = conn.WriteJSON(config); err != nil {
						t.Error(err)
						return
					}
					if protocol == 2 {
						var hello LiveHello
						if err = conn.ReadJSON(&hello); err != nil {
							t.Error(err)
							return
						}
						if hello.Type != "hello" {
							t.Error("missing hello")
							return
						}
						if err = conn.WriteJSON(liveControl{Type: "hello_ack"}); err != nil {
							t.Error(err)
							return
						}
					}
					var report struct {
						Sequence uint64 `json:"sequence"`
					}
					if err = conn.ReadJSON(&report); err != nil {
						t.Error(err)
						return
					}
					if report.Sequence != 1 {
						t.Error("unexpected sequence")
						return
					}
					switch terminal {
					case "ack":
						err = conn.WriteJSON(liveControl{Type: "ack", Sequence: report.Sequence})
					case "wrong-ack":
						err = conn.WriteJSON(liveControl{Type: "ack", Sequence: report.Sequence + 1})
					case "revoked":
						err = conn.WriteJSON(liveControl{Type: "revoked"})
					}
					if err != nil {
						t.Error(err)
					}
				}))
				defer client.Close()
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				var sequence uint64
				err := client.Live(ctx, NewCollector(cfg, "test"), strings.Repeat("a", 32), &sequence, true)
				if sequence != 1 {
					t.Fatalf("sent %d reports", sequence)
				}
				switch terminal {
				case "ack":
					if err != nil {
						t.Fatal(err)
					}
				case "revoked":
					if !errors.Is(err, ErrRevoked) {
						t.Fatalf("revocation lost before close: %v", err)
					}
				default:
					if err == nil {
						t.Fatal("unacknowledged report accepted")
					}
				}
			})
		}
	}
}

func TestLiveReaderCancellationUnblocksFullEventQueue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		for i := 1; i <= 8; i++ {
			if conn.WriteJSON(liveControl{Type: "ack", Sequence: uint64(i)}) != nil {
				return
			}
		}
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, done := make(chan liveEvent, 1), make(chan struct{})
	go func() { defer close(done); readLiveEvents(ctx, conn, events) }()
	select {
	case event := <-events:
		if event.err != nil {
			t.Fatal(event.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("reader did not receive controls")
	}
	cancel()
	conn.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled reader remained blocked on its queue")
	}
}
