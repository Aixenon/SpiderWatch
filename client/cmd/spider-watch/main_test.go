package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"spiderwatch/client/internal/agent"
)

func TestRequestedUpdateRequiresInstalledBridgeAndExclusiveMode(t *testing.T) {
	for _, args := range [][]string{
		{"update", "--requested", "--check"},
		{"update", "--requested", "--automatic"},
		{"update", "--requested", "--config", filepath.Join(t.TempDir(), "config.json")},
	} {
		var out, errOut bytes.Buffer
		if err := execute(context.Background(), args, &out, &errOut); err == nil {
			t.Fatalf("accepted uninstalled or conflicting requested update mode: %v", args)
		}
	}
}

func TestInvitationJoinsExistingPendingIdentityWithoutAnotherApproval(t *testing.T) {
	t.Setenv("CF_ACCESS_CLIENT_ID", "")
	t.Setenv("CF_ACCESS_CLIENT_SECRET", "")
	c, err := agent.NewConfig()
	if err != nil {
		t.Fatal(err)
	}
	c.Group, c.IdentityMode, c.Bootstrap, c.AllowLocalHTTP = "a1b2c3d4e5f6g7h8", "ed25519", true, true
	publicKey, err := c.SSHPublicKey()
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	state, joins := "pending", 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("X-Monitor-Node-ID") != c.NodeID || r.Header.Get("X-Monitor-Signature") == "" {
			t.Error("missing device signature")
		}
		if r.URL.Path == "/bootstrap/enroll" {
			joins++
			var join agent.JoinRequest
			if err := json.NewDecoder(r.Body).Decode(&join); err != nil {
				t.Error(err)
			}
			if join.Protocol != 2 || join.PublicKey != publicKey || r.Header.Get("X-Monitor-Invitation") != "test-invitation" {
				t.Error("enrollment changed identity or omitted invitation")
			}
			state = "approved"
		} else if r.URL.Path != "/bootstrap/status" {
			t.Error("unexpected path", r.URL.Path)
		}
		fmt.Fprintf(w, `{"state":%q,"transport":"websocket","interval_seconds":600}`, state)
	}))
	defer server.Close()
	c.Server = server.URL
	config := filepath.Join(t.TempDir(), "state", "config.json")
	if err := agent.SaveConfig(config, c); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		var out bytes.Buffer
		err := execute(context.Background(), []string{"configure", "--server", server.URL + "/#invite=test-invitation", "--join", c.Group, "--allow-local-http", "--config", config}, &out, &bytes.Buffer{})
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]string
		if err := json.Unmarshal(out.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result["state"] != "approved" {
			t.Fatal("invitation did not immediately authorize device")
		}
		stored, err := agent.LoadConfig(config)
		if err != nil {
			t.Fatal(err)
		}
		if stored.NodeID != c.NodeID || stored.IdentitySeed != c.IdentitySeed || stored.Invitation != "" {
			t.Fatal("identity changed or consumed invitation persisted")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if joins != 1 {
		t.Fatalf("approved identity reenrolled %d times", joins)
	}
}

func TestCLIConfigureJoinAndPersistentIdentity(t *testing.T) {
	t.Setenv("CF_ACCESS_CLIENT_ID", "")
	t.Setenv("CF_ACCESS_CLIENT_SECRET", "")
	t.Setenv("CF_MONITOR_JOIN_TICKET", "")
	var mu sync.Mutex
	state, nodeID, deviceKey := "", "", ""
	expectedAccess := "access-secret"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("CF-Access-Client-Id") != "access-id" || r.Header.Get("CF-Access-Client-Secret") != expectedAccess {
			t.Error("missing configured Access credentials")
			w.WriteHeader(401)
			fmt.Fprint(w, `{"code":"access_required"}`)
			return
		}
		if r.URL.Path == "/v1/enroll" {
			var body map[string]json.RawMessage
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if _, exists := body["ticket"]; exists {
				t.Error("production enrollment still sent a ticket")
			}
			var join agent.JoinRequest
			encoded, _ := json.Marshal(body)
			if err := json.Unmarshal(encoded, &join); err != nil {
				t.Error(err)
			}
			if join.Group != "network-123" {
				w.WriteHeader(404)
				fmt.Fprint(w, `{"code":"network_not_found"}`)
				return
			}
			if nodeID != "" && (join.NodeID != nodeID || join.DeviceKey != deviceKey) {
				t.Error("join regenerated the persistent identity")
			}
			nodeID, deviceKey = join.NodeID, join.DeviceKey
			if state == "" {
				state = "pending"
			}
		} else if r.Header.Get("X-Monitor-Node-ID") != nodeID || r.Header.Get("Authorization") != "Bearer "+deviceKey {
			t.Error("missing individual device credentials")
		}
		fmt.Fprintf(w, `{"state":%q,"transport":"websocket","interval_seconds":60}`, state)
	}))
	defer server.Close()
	root := t.TempDir()
	config, access, ca := filepath.Join(root, "state", "config.json"), filepath.Join(root, "access.json"), filepath.Join(root, "ca.pem")
	if err := os.WriteFile(access, []byte(`{"client_id":"access-id","client_secret":"access-secret"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	command := func(args ...string) map[string]string {
		t.Helper()
		var out, errOut bytes.Buffer
		args = append(args, "--config", config)
		if err := execute(context.Background(), args, &out, &errOut); err != nil {
			t.Fatalf("command %s: %v", args[0], err)
		}
		if strings.Contains(out.String()+errOut.String(), "access-secret") || deviceKey != "" && strings.Contains(out.String()+errOut.String(), deviceKey) {
			t.Fatal("command leaked authentication secrets")
		}
		var result map[string]string
		if err := json.Unmarshal(out.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	configured := command("configure", "--server", server.URL, "--access-file", access, "--ca-file", ca)
	staged, err := agent.LoadSetupConfig(config)
	if err != nil || staged.Group != "" || staged.NodeID != configured["node_id"] {
		t.Fatal("configuration before enrollment failed:", err)
	}
	if _, err := agent.LoadConfig(config); err == nil {
		t.Fatal("unjoined configuration was usable for reporting")
	}
	if joined := command("--join", "network-123", "--name", "test-node"); joined["state"] != "pending" || joined["node_id"] != staged.NodeID {
		t.Fatal("initial join did not preserve configured identity")
	}
	mu.Lock()
	state = "approved"
	mu.Unlock()
	if command("join", "network-123")["state"] != "approved" {
		t.Fatal("repeat join did not retain approval")
	}
	if command("status")["state"] != "approved" {
		t.Fatal("approved status lost")
	}
	// Credential rotation also preserves identity and membership.
	if err := os.WriteFile(access, []byte(`{"client_id":"access-id","client_secret":"rotated-secret"}`), 0600); err != nil {
		t.Fatal(err)
	}
	command("configure", "--access-file", access)
	mu.Lock()
	expectedAccess = "rotated-secret"
	mu.Unlock()
	if command("--join=network-123")["state"] != "approved" {
		t.Fatal("credential change forced another approval")
	}
	command("leave")
	left, err := agent.LoadSetupConfig(config)
	if err != nil || left.Group != "" || left.NodeID != staged.NodeID || left.DeviceKey != staged.DeviceKey {
		t.Fatal("leave discarded the identity")
	}
	// A mistyped network never replaces the staged selection or identity.
	if err := execute(context.Background(), []string{"--join", "missing", "--config", config}, &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
		t.Fatal("unknown network accepted")
	}
	failed, _ := agent.LoadSetupConfig(config)
	if failed.Group != "" || failed.NodeID != left.NodeID {
		t.Fatal("failed join corrupted the local selection")
	}
	if command("--join", "network-123")["state"] != "approved" {
		t.Fatal("local leave reset administrator approval")
	}
	mu.Lock()
	state = "" // Panel deletion is the sole reset of membership.
	mu.Unlock()
	if command("--join", "network-123")["state"] != "pending" {
		t.Fatal("join after panel deletion bypassed approval")
	}
	lock, err := agent.AcquireLock(config)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := execute(context.Background(), []string{"configure", "--config", config, "--access-file", access}, &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
		t.Fatal("configuration changed while another process held its lock")
	}
}
