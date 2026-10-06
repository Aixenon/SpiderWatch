package agent

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProcSemantics(t *testing.T) {
	cpu, err := parseCPU([]byte("cpu 100 20 30 400 10 5 5 10 99 99\n"))
	if err != nil || cpu.total != 580 || cpu.idle != 410 {
		t.Fatalf("guest counted twice or bad idle: %+v %v", cpu, err)
	}
	usage := cpuUsage(cpuCounters{total: 100, idle: 50}, cpuCounters{total: 200, idle: 100})
	if usage == nil || *usage != 50 {
		t.Fatalf("CPU usage=%v", usage)
	}
	if cpuUsage(cpuCounters{total: 200, idle: 100}, cpuCounters{total: 100, idle: 50}) != nil {
		t.Fatal("CPU reset must not produce a percentage")
	}
	if _, err := parseCPU([]byte("cpu bad 0 0 0")); err == nil {
		t.Fatal("malformed CPU accepted")
	}
	mem, err := parseMemory([]byte("MemTotal: 1000 kB\nMemAvailable: 700 kB\nMemFree: 100 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB\n"))
	if err != nil || mem.Used != 300*1024 || mem.SwapUsed != 60*1024 || mem.Estimated {
		t.Fatalf("memory: %+v %v", mem, err)
	}
	legacy, err := parseMemory([]byte("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 100 kB\nCached: 300 kB\nSReclaimable: 100 kB\nShmem: 50 kB\n"))
	if err != nil || !legacy.Estimated || legacy.Available != 550*1024 {
		t.Fatalf("legacy memory: %+v %v", legacy, err)
	}
	netData := []byte("Inter-| Receive | Transmit\n lo: 1 0 0 0 0 0 0 0 2 0 0 0 0 0 0 0\n eth0: 4294967300 0 0 0 0 0 0 0 8589934600 0 0 0 0 0 0 0\n br0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n")
	networks, err := parseNetworks(netData, Config{Interfaces: []string{"eth0"}})
	if err != nil || len(networks) != 1 || networks[0].rx != 4294967300 {
		t.Fatalf("64-bit interface allowlist: %+v %v", networks, err)
	}
}

func validTestConfig(t *testing.T) Config {
	t.Helper()
	c, err := NewConfig()
	if err != nil {
		t.Fatal(err)
	}
	c.Server, c.Group = "https://agent.example.test", "test"
	c.Access = AccessCredentials{ClientID: "test-access-id", ClientSecret: "test-access-secret"}
	return c
}

func TestConfigBoundsIdentityAndLock(t *testing.T) {
	c := validTestConfig(t)
	path := filepath.Join(t.TempDir(), "identity", "config.json")
	if err := SaveConfig(path, c); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(path)
	if err != nil || loaded.NodeID != c.NodeID || loaded.DeviceKey != c.DeviceKey {
		t.Fatalf("identity persistence: %+v %v", loaded, err)
	}
	if err := SaveConfig(path, c); err != nil {
		t.Fatalf("atomic replacement: %v", err)
	}
	l, err := AcquireLock(path)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := AcquireLock(path); err == nil {
		second.Close()
		t.Fatal("second process lock allowed")
	}
	l.Close()
	l, err = AcquireLock(path)
	if err != nil {
		t.Fatal("lock was not released:", err)
	}
	l.Close()
	if err := os.WriteFile(path, []byte(strings.Repeat("x", MaxConfigBytes+1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("oversized config accepted")
	}
	c.Server, c.AllowLocalHTTP = "http://192.168.1.1", true
	if c.Validate() == nil {
		t.Fatal("plaintext LAN credentials accepted")
	}
	c.Server = "http://127.0.0.1:8787"
	if c.Validate() != nil {
		t.Fatal("explicit loopback development rejected")
	}
}

func tlsTestClient(t *testing.T, handler http.Handler, enableHTTP2 ...bool) (*Client, Config, *httptest.Server) {
	t.Helper()
	s := httptest.NewUnstartedServer(handler)
	s.EnableHTTP2 = len(enableHTTP2) > 0 && enableHTTP2[0]
	if s.EnableHTTP2 {
		s.TLS = &tls.Config{NextProtos: []string{"h2", "http/1.1"}}
	}
	s.StartTLS()
	t.Cleanup(s.Close)
	c := validTestConfig(t)
	c.Server = s.URL
	c.CAFile = filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(c.CAFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return client, c, s
}

func TestTLSAuthEnrollmentAndBodyBounds(t *testing.T) {
	var cfg Config
	var requests atomic.Int32
	client, c, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("CF-Access-Client-Id") != cfg.Access.ClientID || r.Header.Get("CF-Access-Client-Secret") != cfg.Access.ClientSecret || r.Header.Get("Authorization") != "Bearer "+cfg.DeviceKey {
			t.Error("authentication headers missing")
		}
		if r.ProtoMajor != 1 {
			t.Error("HTTP/1.1 fallback failed")
		}
		if r.URL.Path == "/v1/enroll" {
			var join JoinRequest
			if json.NewDecoder(r.Body).Decode(&join) != nil || join.NodeID != cfg.NodeID || join.Ticket != "one-time-ticket" {
				t.Error("bad enrollment")
			}
		}
		_ = json.NewEncoder(w).Encode(ControlResponse{State: "pending"})
	}))
	cfg = c
	response, err := client.Join(context.Background(), "one-time-ticket", NewCollector(c, "test").Host())
	if err != nil || response.State != "pending" {
		t.Fatalf("join: %+v %v", response, err)
	}
	if _, err = client.Status(context.Background()); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 {
		t.Fatal("unexpected request count")
	}
	large, _, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("x", MaxResponseBytes+1))
	}))
	if _, err = large.Status(context.Background()); err == nil {
		t.Fatal("oversized response accepted")
	}
}

func TestNoRedirectCredentialLeak(t *testing.T) {
	var leaked atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
	defer destination.Close()
	client, _, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	if _, err := client.Status(context.Background()); err == nil {
		t.Fatal("redirect accepted")
	}
	if leaked.Load() {
		t.Fatal("redirect was followed and credentials could leak")
	}
}

func TestPendingNeverReportsAndRevocationStops(t *testing.T) {
	var reports atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/metrics" {
			reports.Add(1)
		}
		_ = json.NewEncoder(w).Encode(ControlResponse{State: "pending"})
	}))
	client.Close()
	if err := Run(context.Background(), config, RunOptions{Once: true, Version: "test"}); err != nil {
		t.Fatal(err)
	}
	if reports.Load() != 0 {
		t.Fatal("pending device submitted metrics")
	}
	revokedClient, revoked, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(ControlResponse{State: "revoked"})
	}))
	revokedClient.Close()
	if err := Run(context.Background(), revoked, RunOptions{Once: true}); !errors.Is(err, ErrRevoked) {
		t.Fatalf("revocation: %v", err)
	}
}

func TestBackoffAndServiceHardLimit(t *testing.T) {
	for _, failures := range []int{1, 2, 6, 1000000} {
		d := retryDelay(time.Minute, failures)
		if d < time.Minute || d > 330*time.Second {
			t.Fatalf("unbounded backoff: %v", d)
		}
	}
	// Paths are Linux paths; test the rendered unit on Linux in CI.
	if os.PathSeparator == '/' {
		unit, err := SystemdUnit("/usr/local/bin/spider-watch", "/var/lib/spider-watch/config.json", "spider-watch")
		if err != nil || !strings.Contains(unit, "MemoryMax=32M") || !strings.Contains(unit, "LimitCORE=0") {
			t.Fatalf("service cap: %s %v", unit, err)
		}
	}
}
