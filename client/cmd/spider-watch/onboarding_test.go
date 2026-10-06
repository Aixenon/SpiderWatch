package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"spiderwatch/client/internal/agent"
)

func TestOneCommandJoinAndAutomaticTLSCredentialDelivery(t *testing.T) {
	t.Setenv("CF_ACCESS_CLIENT_ID", "")
	t.Setenv("CF_ACCESS_CLIENT_SECRET", "")
	var approved atomic.Bool
	var reports atomic.Int32
	var identity agent.JoinRequest
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/bootstrap/enroll" {
			if r.Header.Get("CF-Access-Client-Secret") != "" {
				t.Error("initial enrollment sent Access")
			}
			if err := json.NewDecoder(r.Body).Decode(&identity); err != nil {
				t.Error(err)
			}
			if identity.Group != "100000000001" || identity.Name != "" || identity.Host.Hostname == "" {
				t.Error("wrong numeric network or client-assigned nickname")
			}
			fmt.Fprint(w, `{"state":"pending","transport":"websocket","interval_seconds":60}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+identity.DeviceKey {
			t.Error("missing private device proof")
		}
		if r.URL.Path == "/bootstrap/status" {
			if r.Header.Get("CF-Access-Client-Secret") != "" {
				t.Error("approval waiting required Access")
			}
			if !approved.Load() {
				fmt.Fprint(w, `{"state":"pending","transport":"websocket","interval_seconds":60}`)
				return
			}
			fmt.Fprint(w, `{"state":"approved","transport":"websocket","interval_seconds":600,"access":{"client_id":"delivered-id","client_secret":"delivered-secret"}}`)
			return
		}
		if r.Header.Get("CF-Access-Client-Secret") != "delivered-secret" || r.Header.Get("CF-Access-Client-Id") != "delivered-id" {
			t.Error("online connection missing delivered Access")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path != "/v1/live" {
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(map[string]any{"type": "config", "state": "approved", "active_seconds": 5, "idle_seconds": 600, "interval_seconds": 600, "version": 1, "compression": "gzip"})
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Error(err)
			return
		}
		if kind != websocket.BinaryMessage {
			t.Error("report was not gzip binary")
		}
		reader, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			t.Error(err)
			return
		}
		decoded, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Error(err)
			return
		}
		var report agent.ReportRequest
		if json.Unmarshal(decoded, &report) != nil || report.NodeID != identity.NodeID {
			t.Error("bad compressed report")
		}
		reports.Add(1)
		_ = conn.WriteJSON(map[string]any{"type": "ack", "sequence": report.Sequence})
	}))
	defer server.Close()
	root := t.TempDir()
	path := filepath.Join(root, "config.json")
	ca := filepath.Join(root, "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	args := []string{"configure", "--server", server.URL, "--join", "100000000001", "--config", path, "--ca-file", ca}
	if err := execute(context.Background(), args, &output, &output); err != nil {
		t.Fatal(err)
	}
	configured, err := agent.LoadConfig(path)
	if err != nil || !configured.Bootstrap || configured.Access.ClientID != "" {
		t.Fatalf("initial config %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = execute(ctx, []string{"run", "--once", "--config", path}, &output, &output); err != nil {
		t.Fatal(err)
	}
	if reports.Load() != 0 {
		t.Fatal("pending device uploaded metrics")
	}
	approved.Store(true)
	if err = execute(ctx, []string{"run", "--once", "--config", path}, &output, &output); err != nil {
		t.Fatal(err)
	}
	saved, err := agent.LoadConfig(path)
	if err != nil || saved.Access.ClientSecret != "delivered-secret" || saved.NodeID != configured.NodeID || saved.DeviceKey != configured.DeviceKey || reports.Load() != 1 {
		t.Fatal("automatic provision did not preserve credentials and identity")
	}
	if bytes.Contains(output.Bytes(), []byte("delivered-secret")) || bytes.Contains(output.Bytes(), []byte(configured.DeviceKey)) {
		t.Fatal("CLI exposed credentials")
	}
}
