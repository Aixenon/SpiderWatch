package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

	"spiderwatch/client/internal/agent"
)

const localMembershipOldGroup = "a1b2c3d4e5f6g7h8"
const localMembershipNewGroup = "z8y7x6w5v4u3t2s1"

func localMembershipConfig(t *testing.T, server string) (string, agent.Config) {
	t.Helper()
	t.Setenv("CF_ACCESS_CLIENT_ID", "")
	t.Setenv("CF_ACCESS_CLIENT_SECRET", "")
	t.Setenv("CF_MONITOR_JOIN_TICKET", "")
	c, err := agent.NewConfig()
	if err != nil {
		t.Fatal(err)
	}
	c.Server, c.Group = server, localMembershipOldGroup
	c.IdentityMode, c.Bootstrap, c.AllowLocalHTTP = "ed25519", true, true
	c.Name, c.Invitation = "old-network-name", "old-invitation"
	c.Access = agent.AccessCredentials{ClientID: "old-access-id", ClientSecret: "old-access-secret"}
	c.Interval, c.Timeout = 60, 1
	c.Interfaces = []string{"test-interface"}
	path := filepath.Join(t.TempDir(), "state", "config.json")
	if err := agent.SaveConfig(path, c); err != nil {
		t.Fatal(err)
	}
	return path, c
}

func assertLocalMembershipIdentity(t *testing.T, stored, initial agent.Config) {
	t.Helper()
	if stored.NodeID != initial.NodeID || stored.DeviceKey != initial.DeviceKey ||
		stored.IdentitySeed != initial.IdentitySeed || stored.IdentityMode != initial.IdentityMode {
		t.Fatal("local membership change replaced the device identity")
	}
	if stored.Interval != initial.Interval || stored.Timeout != initial.Timeout ||
		fmt.Sprint(stored.Interfaces) != fmt.Sprint(initial.Interfaces) || fmt.Sprint(stored.Mounts) != fmt.Sprint(initial.Mounts) {
		t.Fatal("local membership change discarded collection settings")
	}
}

func TestLocalLeaveWithoutRemoteConnectivity(t *testing.T) {
	for _, offline := range []bool{false, true} {
		name := "forbidden"
		if offline {
			name = "offline"
		}
		t.Run(name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusForbidden)
				fmt.Fprint(w, `{"code":"revoked"}`)
			}))
			defer server.Close()
			path, initial := localMembershipConfig(t, server.URL)
			if offline {
				server.Close()
				// Leaving does not need to open the old endpoint's trust file.
				initial.CAFile = filepath.Join(t.TempDir(), "missing-old-ca.pem")
				if err := agent.SaveConfig(path, initial); err != nil {
					t.Fatal(err)
				}
			}
			for attempt := 0; attempt < 2; attempt++ {
				var out, errOut bytes.Buffer
				if err := execute(context.Background(), []string{"leave", "--config", path}, &out, &errOut); err != nil {
					t.Fatalf("local leave attempt %d: %v", attempt+1, err)
				}
				var result map[string]string
				if err := json.Unmarshal(out.Bytes(), &result); err != nil || result["state"] != "left" || result["node_id"] != initial.NodeID {
					t.Fatal("leave did not report the retained local identity", out.String(), err)
				}
				stored, err := agent.LoadSetupConfig(path)
				if err != nil {
					t.Fatal(err)
				}
				assertLocalMembershipIdentity(t, stored, initial)
				if stored.Group != "" || stored.Invitation != "" || stored.Gate != "" {
					t.Fatal("leave kept active network membership or enrollment credentials")
				}
				if stored.Server != initial.Server || stored.Access != initial.Access || stored.CAFile != initial.CAFile {
					t.Fatal("leave discarded settings needed to rejoin the same server")
				}
				if _, err := agent.LoadConfig(path); err == nil {
					t.Fatal("left configuration remained usable for reporting")
				}
			}
			if requests.Load() != 0 {
				t.Fatal("local leave contacted the old server")
			}
		})
	}
}

func TestLocalSwitchNetworkPreservesIdentity(t *testing.T) {
	for _, test := range []struct {
		name       string
		sameServer bool
		invitation bool
	}{
		{name: "new_server_invitation", invitation: true},
		{name: "new_server_without_invitation"},
		{name: "same_server_new_group", sameServer: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var oldRequests, enrollments atomic.Int32
			oldServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				oldRequests.Add(1)
				w.WriteHeader(http.StatusForbidden)
			}))
			defer oldServer.Close()
			path, initial := localMembershipConfig(t, oldServer.URL)
			publicKey, err := initial.SSHPublicKey()
			if err != nil {
				t.Fatal(err)
			}
			newServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				enrollments.Add(1)
				if r.Method != http.MethodPost || r.URL.Path != "/bootstrap/enroll" {
					t.Error("network switch did not enroll directly", r.Method, r.URL.Path)
				}
				if r.Header.Get("CF-Access-Client-Id") != "" || r.Header.Get("CF-Access-Client-Secret") != "" {
					t.Error("enrollment disclosed old Access credentials")
				}
				invitation := ""
				if test.invitation {
					invitation = "fresh-invitation"
				}
				if r.Header.Get("X-Monitor-Invitation") != invitation {
					t.Error("network switch retained an old invitation")
				}
				if r.Header.Get("X-Monitor-Node-ID") != initial.NodeID || r.Header.Get("X-Monitor-Signature") == "" {
					t.Error("network switch did not use the persistent signing identity")
				}
				var join agent.JoinRequest
				if err := json.NewDecoder(r.Body).Decode(&join); err != nil {
					t.Error(err)
				}
				if join.Group != localMembershipNewGroup || join.NodeID != initial.NodeID || join.Protocol != 2 ||
					join.PublicKey != publicKey || join.Name != "" || join.DeviceKey != "" {
					t.Error("new enrollment retained old membership or changed identity")
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"state":"approved","transport":"websocket","interval_seconds":600}`)
			}))
			defer newServer.Close()
			if test.sameServer {
				initial.Server = newServer.URL
			} else {
				// A vanished private CA belonging to the old endpoint must not
				// prevent joining a different server using its own trust settings.
				initial.CAFile = filepath.Join(t.TempDir(), "missing-old-ca.pem")
			}
			if err := agent.SaveConfig(path, initial); err != nil {
				t.Fatal(err)
			}
			serverURL := newServer.URL
			if test.invitation {
				serverURL += "/#invite=fresh-invitation"
			}
			var out, errOut bytes.Buffer
			if err := execute(context.Background(), []string{"configure", "--server", serverURL, "--join", localMembershipNewGroup, "--allow-local-http", "--config", path}, &out, &errOut); err != nil {
				t.Fatal("direct network switch failed:", err)
			}
			stored, err := agent.LoadConfig(path)
			if err != nil {
				t.Fatal(err)
			}
			assertLocalMembershipIdentity(t, stored, initial)
			if stored.Server != newServer.URL || stored.Group != localMembershipNewGroup || stored.Invitation != "" || stored.Gate != "" || stored.Name != "" {
				t.Fatal("new membership was not saved cleanly")
			}
			if !test.sameServer && (stored.Access != (agent.AccessCredentials{}) || stored.CAFile != "") {
				t.Fatal("old endpoint credentials or CA followed the device to another server")
			}
			if test.sameServer && stored.Access != initial.Access {
				t.Fatal("same-server switch discarded legacy Access settings")
			}
			if oldRequests.Load() != 0 || enrollments.Load() != 1 {
				t.Fatal("switch contacted the old server or queried status instead of enrolling", oldRequests.Load(), enrollments.Load())
			}
		})
	}
}

func TestFailedLocalNetworkSwitchDoesNotRestoreOldMembership(t *testing.T) {
	for _, offline := range []bool{false, true} {
		name := "forbidden"
		if offline {
			name = "offline"
		}
		t.Run(name, func(t *testing.T) {
			var oldRequests, newRequests atomic.Int32
			oldServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				oldRequests.Add(1)
				w.WriteHeader(http.StatusForbidden)
			}))
			defer oldServer.Close()
			newServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				newRequests.Add(1)
				w.WriteHeader(http.StatusForbidden)
				fmt.Fprint(w, `{"code":"forbidden"}`)
			}))
			defer newServer.Close()
			if offline {
				newServer.Close()
			}
			path, initial := localMembershipConfig(t, oldServer.URL)
			initial.CAFile = filepath.Join(t.TempDir(), "missing-old-ca.pem")
			if err := agent.SaveConfig(path, initial); err != nil {
				t.Fatal(err)
			}
			var out, errOut bytes.Buffer
			if err := execute(context.Background(), []string{"configure", "--server", newServer.URL + "/#invite=fresh-invitation", "--join", localMembershipNewGroup, "--allow-local-http", "--config", path}, &out, &errOut); err == nil {
				t.Fatal("unreachable or forbidden new network was accepted")
			}
			stored, err := agent.LoadSetupConfig(path)
			if err != nil {
				t.Fatal(err)
			}
			assertLocalMembershipIdentity(t, stored, initial)
			if stored.Group != "" || stored.Server != newServer.URL || stored.Name != "" || stored.Gate != "" ||
				stored.Invitation != "fresh-invitation" || stored.Access != (agent.AccessCredentials{}) || stored.CAFile != "" {
				t.Fatal("failed switch restored old membership or lost the new staged setup")
			}
			if _, err := agent.LoadConfig(path); err == nil {
				t.Fatal("failed enrollment remained usable for reporting")
			}
			if oldRequests.Load() != 0 || (!offline && newRequests.Load() == 0) {
				t.Fatal("failed switch contacted the old server or never attempted the new server")
			}
		})
	}
}

func TestConfigureDifferentServerWithoutJoinLeavesLocally(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	path, initial := localMembershipConfig(t, server.URL)
	var out, errOut bytes.Buffer
	newServer := "http://127.0.0.1:1"
	if err := execute(context.Background(), []string{"configure", "--server", newServer, "--allow-local-http", "--config", path}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	stored, err := agent.LoadSetupConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	assertLocalMembershipIdentity(t, stored, initial)
	if stored.Group != "" || stored.Server != newServer || stored.Invitation != "" || stored.Access != (agent.AccessCredentials{}) {
		t.Fatal("configure inherited the old network at another endpoint")
	}
	if requests.Load() != 0 {
		t.Fatal("staging another endpoint contacted the old server")
	}
}
