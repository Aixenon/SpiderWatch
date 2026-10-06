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

func TestLiveReconnectBackoffBoundsAndSupersededCooling(t *testing.T) {
	for i, seconds := range []int{2, 5, 10, 30, 60, 60, 60} {
		for j := 0; j < 20; j++ {
			delay := liveRetryDelay(i+1, false)
			if delay < time.Duration(seconds)*time.Second || delay > time.Duration(seconds)*1100*time.Millisecond {
				t.Fatalf("failure %d: %s", i+1, delay)
			}
		}
	}
	if delay := liveRetryDelay(1, true); delay < time.Minute || delay > 66*time.Second {
		t.Fatal(delay)
	}
}

func TestLiveHalfOpenTimeoutAndAcknowledgedHealth(t *testing.T) {
	for _, scenario := range []string{"half-open", "server-close", "superseded"} {
		t.Run(scenario, func(t *testing.T) {
			finish := make(chan struct{})
			defer close(finish)
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				_ = conn.WriteJSON(liveTestConfig(30, 1))
				var report ReportRequest
				if conn.ReadJSON(&report) != nil {
					return
				}
				_ = conn.WriteJSON(liveControl{Type: "ack", Sequence: report.Sequence})
				if scenario == "half-open" {
					<-finish
				}
				if scenario == "superseded" {
					_ = conn.WriteJSON(liveControl{Type: "superseded"})
				}
			}))
			var recovered atomic.Int32
			client.liveHealthy = func() { recovered.Add(1) }
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var sequence uint64
			started := time.Now()
			err := client.live(ctx, NewCollector(config, "test"), strings.Repeat("a", 32), &sequence, false, liveTiming{100 * time.Millisecond, 1500 * time.Millisecond})
			if err == nil || recovered.Load() != 1 || errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("health=%d error=%v", recovered.Load(), err)
			}
			if scenario == "half-open" && time.Since(started) > 3*time.Second {
				t.Fatal("half-open connection waited for reporting interval")
			}
			if (scenario == "superseded") != errors.Is(err, errLiveSuperseded) {
				t.Fatal("lost superseded classification")
			}
		})
	}
}

func TestRunResetsReconnectBackoffAfterAcknowledgedSession(t *testing.T) {
	times := make(chan time.Time, 3)
	var connections atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/status") {
			_ = json.NewEncoder(w).Encode(ControlResponse{State: "approved", Transport: "websocket"})
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		n := connections.Add(1)
		times <- time.Now()
		if n == 1 {
			return
		}
		if n == 3 {
			_ = conn.WriteJSON(liveControl{Type: "revoked"})
			return
		}
		_ = conn.WriteJSON(liveTestConfig(30, 1))
		var report ReportRequest
		if conn.ReadJSON(&report) == nil {
			_ = conn.WriteJSON(liveControl{Type: "ack", Sequence: report.Sequence})
		}
	}))
	client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer cancel()
	if err := Run(ctx, config, RunOptions{Version: "test"}); !errors.Is(err, ErrRevoked) {
		t.Fatal(err)
	}
	first, second, third := <-times, <-times, <-times
	for _, delay := range []time.Duration{second.Sub(first), third.Sub(second)} {
		if delay < 2*time.Second || delay > 4*time.Second {
			t.Fatalf("healthy connection did not reset retry delay: %s", delay)
		}
	}
}

func TestRunRetriesFailedInitialHandshakeWithoutWaitingForReportInterval(t *testing.T) {
	var statuses atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/status") {
			if statuses.Add(1) == 1 {
				w.WriteHeader(503)
				return
			}
			_ = json.NewEncoder(w).Encode(ControlResponse{State: "approved", Transport: "websocket"})
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(liveControl{Type: "revoked"})
	}))
	client.Close()
	config.Interval = 600
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started := time.Now()
	if err := Run(ctx, config, RunOptions{Version: "test"}); !errors.Is(err, ErrRevoked) {
		t.Fatal(err)
	}
	if statuses.Load() != 2 || time.Since(started) > 4*time.Second {
		t.Fatal("initial handshake kept the report interval backoff")
	}
}

func TestRunPendingStateKeepsNormalInterval(t *testing.T) {
	var statuses atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		statuses.Add(1)
		_ = json.NewEncoder(w).Encode(ControlResponse{State: "pending"})
	}))
	client.Close()
	config.Interval = 600
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := Run(ctx, config, RunOptions{Version: "test"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if statuses.Load() != 1 {
		t.Fatal("pending approval was polled at the reconnect interval")
	}
}
