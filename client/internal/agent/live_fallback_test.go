package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func shortFallbackTiming() fallbackTiming {
	return fallbackTiming{report: 80 * time.Millisecond, retry: func(int, bool) time.Duration { return 10 * time.Millisecond }}
}

func fallbackTestCollector(config Config) *Collector {
	return &Collector{config: config, host: HostInfo{Version: "test"}}
}

func TestFallbackRetryBoundsAndProductionIntervals(t *testing.T) {
	for i, seconds := range []int{2, 5, 10, 30, 60, 120, 300, 300} {
		for range 20 {
			delay := fallbackRetryDelay(i+1, true)
			minimum, maximum := time.Duration(seconds)*time.Second, time.Duration(seconds)*1100*time.Millisecond
			if seconds == 300 {
				minimum, maximum = 270*time.Second, 300*time.Second
			}
			if delay < minimum || delay > maximum {
				t.Fatalf("failure %d: %s", i+1, delay)
			}
		}
	}
	if defaultFallbackTiming().report != time.Minute || fallbackAfterFailures != 3 || livePingInterval != 30*time.Second || liveReadTimeout != 90*time.Second {
		t.Fatal("unexpected production reconnect or fallback limits")
	}
}

func TestFallbackFailedSessionsKeepRetryingWithoutAcceleratingHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var attempts atomic.Int32
	var mu sync.Mutex
	var times []time.Time
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/metrics" {
			_, _ = io.Copy(io.Discard, r.Body)
			mu.Lock()
			times = append(times, time.Now())
			done := len(times) == 3
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(ControlResponse{State: "approved"})
			if done {
				cancel()
			}
			return
		}
		if attempts.Add(1) <= 3 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(liveTestConfig(30, 1))
		var report ReportRequest
		_ = conn.ReadJSON(&report) // Valid config and metrics, but never a healthy ACK.
	}))
	defer client.Close()
	timing := shortFallbackTiming()
	var retries []int
	timing.retry = func(failures int, _ bool) time.Duration {
		retries = append(retries, failures)
		return 10 * time.Millisecond
	}
	var sequence uint64
	err := client.liveWithFallback(ctx, fallbackTestCollector(config), strings.Repeat("a", 32), &sequence, false, log.New(io.Discard, "", 0), timing)
	if !errors.Is(err, context.Canceled) || attempts.Load() < 5 {
		t.Fatalf("stopped retrying failed sessions: attempts=%d error=%v", attempts.Load(), err)
	}
	mu.Lock()
	defer mu.Unlock()
	for i := 1; i < len(times); i++ {
		if times[i].Sub(times[i-1]) < timing.report-5*time.Millisecond {
			t.Fatal("failed WebSocket session accelerated HTTPS fallback")
		}
	}
	for i, count := range retries {
		if count != i+1 {
			t.Fatalf("valid config without ACK reset failures: %v", retries)
		}
	}
}

func TestFallbackHealthyACKResetsFailuresInFIFOOrder(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var attempts, reports atomic.Int32
	httpSeen := make(chan struct{})
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/metrics" {
			if reports.Add(1) == 1 {
				close(httpSeen)
			}
			_ = json.NewEncoder(w).Encode(ControlResponse{State: "approved"})
			return
		}
		attempt := attempts.Add(1)
		if attempt <= 3 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		select {
		case <-httpSeen:
		case <-ctx.Done():
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		if attempt == 5 {
			_ = conn.WriteJSON(liveControl{Type: "revoked"})
			return
		}
		_ = conn.WriteJSON(liveTestConfig(30, 1))
		var report ReportRequest
		if conn.ReadJSON(&report) == nil {
			_ = conn.WriteJSON(liveControl{Type: "ack", Sequence: report.Sequence})
		}
	}))
	defer client.Close()
	timing := shortFallbackTiming()
	var retries []int
	timing.retry = func(failures int, _ bool) time.Duration {
		retries = append(retries, failures)
		return 10 * time.Millisecond
	}
	var sequence uint64
	err := client.liveWithFallback(ctx, fallbackTestCollector(config), strings.Repeat("a", 32), &sequence, false, log.New(io.Discard, "", 0), timing)
	if !errors.Is(err, ErrRevoked) || len(retries) != 4 || retries[3] != 1 || reports.Load() != 1 {
		t.Fatalf("ACK/disconnect ordering failed: retries=%v reports=%d error=%v", retries, reports.Load(), err)
	}
}

func TestFallbackCancellationJoinsActiveHTTPAndReconnect(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dialStarted := make(chan struct{})
	var attempts atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/metrics" {
			_, _ = io.Copy(io.Discard, r.Body)
			select {
			case <-dialStarted:
				cancel()
			case <-ctx.Done():
			}
			return
		}
		if attempts.Add(1) <= 3 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		close(dialStarted)
		<-r.Context().Done()
	}))
	defer client.Close()
	var sequence uint64
	started := time.Now()
	err := client.liveWithFallback(ctx, fallbackTestCollector(config), strings.Repeat("a", 32), &sequence, false, log.New(io.Discard, "", 0), shortFallbackTiming())
	if !errors.Is(err, context.Canceled) || time.Since(started) > time.Second {
		t.Fatalf("cancellation did not join the active requests promptly: %v", err)
	}
}

func TestLiveFailureDiagnosticsNeverIncludePeerSecrets(t *testing.T) {
	err := liveReadFailure(&websocket.CloseError{Code: 1008, Text: "Authorization=secret https://private.example/path"})
	if !strings.Contains(err.Error(), "1008") || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "private") {
		t.Fatal("close reason leaked through connection diagnostics")
	}
	err = liveReadFailure(context.DeadlineExceeded)
	if err.Error() != "WebSocket read timed out" {
		t.Fatal(err)
	}
}

func TestFallbackStartsAfterThreeFailuresAndNeverResetsFromHTTP(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(map[bool]string{false: "http-success", true: "http-failure"}[failure], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var attempts atomic.Int32
			var mu sync.Mutex
			var times []time.Time
			var reports []ReportRequest
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/live" {
					attempts.Add(1)
					w.WriteHeader(http.StatusBadGateway)
					return
				}
				if r.URL.Path != "/v1/metrics" {
					t.Errorf("unexpected request path %s", r.URL.Path)
					return
				}
				if attempts.Load() < 3 {
					t.Error("HTTPS began before three failed WebSocket attempts")
				}
				var report ReportRequest
				if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
					t.Error(err)
				}
				mu.Lock()
				times = append(times, time.Now())
				reports = append(reports, report)
				done := len(times) == 3
				mu.Unlock()
				if failure {
					w.WriteHeader(http.StatusServiceUnavailable)
				} else {
					_ = json.NewEncoder(w).Encode(ControlResponse{State: "approved", Interval: 1, Transport: "websocket"})
				}
				if done {
					cancel()
				}
			}))
			defer client.Close()
			var retries []int
			timing := shortFallbackTiming()
			timing.retry = func(failures int, _ bool) time.Duration {
				retries = append(retries, failures)
				return 10 * time.Millisecond
			}
			var sequence uint64
			err := client.liveWithFallback(ctx, fallbackTestCollector(config), strings.Repeat("a", 32), &sequence, false, log.New(io.Discard, "", 0), timing)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("did not finish three fallback attempts: %v", err)
			}
			mu.Lock()
			defer mu.Unlock()
			for i, report := range reports {
				if report.Sequence != uint64(i+1) || report.UpdateControl != 1 || report.NodeID != config.NodeID {
					t.Fatalf("invalid fallback report: %+v", report)
				}
				if i > 0 && times[i].Sub(times[i-1]) < timing.report-5*time.Millisecond {
					t.Fatal("fallback attempts bypassed the fixed rate limit")
				}
			}
			for i, count := range retries {
				if count != i+1 {
					t.Fatalf("HTTP result reset WebSocket failures: %v", retries)
				}
			}
			if attempts.Load() < 4 {
				t.Fatal("WebSocket retries stopped during fallback")
			}
		})
	}
}

func TestFallbackReadyCancelsHTTPBeforeWebSocketCollects(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started := make(chan struct{})
	canceled := make(chan struct{})
	var attempts, reports atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/metrics" {
			_, _ = io.Copy(io.Discard, r.Body)
			if reports.Add(1) == 1 {
				close(started)
			}
			select {
			case <-r.Context().Done():
			case <-ctx.Done():
			}
			close(canceled)
			return
		}
		if attempts.Add(1) <= 3 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		select {
		case <-started:
		case <-ctx.Done():
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(liveTestConfig(30, 1))
		var report ReportRequest
		if err = conn.ReadJSON(&report); err != nil {
			t.Error(err)
			return
		}
		select {
		case <-canceled:
		case <-time.After(time.Second):
			t.Error("WebSocket report raced a still-running HTTPS report")
		}
		if report.Sequence != 2 {
			t.Errorf("transport handoff lost sequence ownership: %d", report.Sequence)
		}
		_ = conn.WriteJSON(liveControl{Type: "ack", Sequence: report.Sequence})
		_ = conn.WriteJSON(liveControl{Type: "revoked"})
	}))
	defer client.Close()
	var sequence uint64
	err := client.liveWithFallback(ctx, fallbackTestCollector(config), strings.Repeat("a", 32), &sequence, false, log.New(io.Discard, "", 0), shortFallbackTiming())
	if !errors.Is(err, ErrRevoked) || reports.Load() != 1 {
		t.Fatalf("error=%v HTTPS reports=%d", err, reports.Load())
	}
}

func TestFallbackAuthorizationRejectionsNeverDowngrade(t *testing.T) {
	for _, code := range []string{"revoked", "pending", "access_expired"} {
		t.Run(code, func(t *testing.T) {
			var reports atomic.Int32
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/metrics" {
					reports.Add(1)
				}
				w.WriteHeader(http.StatusForbidden)
				_ = json.NewEncoder(w).Encode(ControlResponse{State: code, Code: code})
			}))
			defer client.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			var sequence uint64
			err := client.liveWithFallback(ctx, fallbackTestCollector(config), strings.Repeat("a", 32), &sequence, false, log.New(io.Discard, "", 0), shortFallbackTiming())
			if !(errors.Is(err, ErrRevoked) || authenticationFailure(err)) || reports.Load() != 0 {
				t.Fatalf("authorization bypass: reports=%d error=%v", reports.Load(), err)
			}
		})
	}
}

func TestFallbackHTTPSRevocationCancelsReconnection(t *testing.T) {
	var attempts atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/live" {
			attempts.Add(1)
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(ControlResponse{State: "revoked", Code: "revoked"})
	}))
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var sequence uint64
	err := client.liveWithFallback(ctx, fallbackTestCollector(config), strings.Repeat("a", 32), &sequence, false, log.New(io.Discard, "", 0), shortFallbackTiming())
	if !errors.Is(err, ErrRevoked) || attempts.Load() < 3 {
		t.Fatal(err)
	}
}

func TestFallbackFailedTriggerReportsAndDeduplicatesAcrossTransports(t *testing.T) {
	const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	var failures atomic.Int32
	client, _, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/update/result" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		var message requestedUpdateResultMessage
		if err := json.NewDecoder(r.Body).Decode(&message); err != nil || message.RequestID != id || message.State != "failed" || message.Code != "update_trigger_failed" {
			t.Errorf("invalid trigger failure: %+v error=%v", message, err)
		}
		failures.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer client.Close()
	client.configPath = "installed-config"
	started, release := make(chan struct{}), make(chan struct{})
	var triggers atomic.Int32
	client.remoteUpdates.trigger = func(context.Context, string) error {
		triggers.Add(1)
		close(started)
		<-release
		return errors.New("bridge unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { client.fallbackUpdate(ctx, id); close(done) }()
	<-started
	wsResult := make(chan remoteUpdateAck, 1)
	go func() { wsResult <- client.remoteUpdates.start(ctx, client.configPath, id) }()
	close(release)
	<-done
	if ack := <-wsResult; ack.State != "failed" || triggers.Load() != 1 || failures.Load() != 1 {
		t.Fatalf("trigger reentry: ack=%+v triggers=%d reports=%d", ack, triggers.Load(), failures.Load())
	}
}
