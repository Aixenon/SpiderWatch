package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDedicatedIdentitySurvivesConfigAndSignsWithoutOpenSSH(t *testing.T) {
	c, err := NewConfig()
	if err != nil {
		t.Fatal(err)
	}
	c.Server, c.Group, c.IdentityMode = "https://monitor.example.com", "abcdefghijklmnop", "ed25519"
	c.Gate = "obsolete-shared-gate"
	if c.NodeID[12] != '4' || !strings.ContainsRune("89ab", rune(c.NodeID[16])) {
		t.Fatal("device ID is not UUIDv4")
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := SaveConfig(path, c); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.IdentitySeed == "" || loaded.IdentitySeed != c.IdentitySeed || loaded.NodeID != c.NodeID {
		t.Fatal("identity changed")
	}
	if loaded.Gate != "" {
		t.Fatal("obsolete gate retained after loading config")
	}
	public, err := loaded.SSHPublicKey()
	if err != nil {
		t.Fatal(err)
	}
	wire, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(public, "ssh-ed25519 "))
	if err != nil || len(wire) != 51 {
		t.Fatal("invalid SSH public key")
	}
	client, err := NewClient(loaded)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	body := []byte(`{"example":"设备"}`)
	req, _ := http.NewRequest("POST", c.Server+"/bootstrap/enroll", nil)
	if err := client.authorizeRequest(req, body); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	canonical := strings.Join([]string{"cf-monitor-auth-v1", "POST", c.Server, "/bootstrap/enroll", c.NodeID, req.Header.Get("X-Monitor-Time"), req.Header.Get("X-Monitor-Nonce"), hex.EncodeToString(digest[:])}, "\n")
	signature, err := base64.StdEncoding.DecodeString(req.Header.Get("X-Monitor-Signature"))
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(ed25519.PublicKey(wire[19:]), []byte(canonical), signature) {
		t.Fatal("signature cannot be independently verified")
	}
	if req.Header.Get("Authorization") != "" || strings.Contains(canonical, c.IdentitySeed) {
		t.Fatal("private credential transmitted")
	}
	if req.Header.Get("X-Monitor-Gate") != "" {
		t.Fatal("obsolete gate transmitted")
	}
	firstNonce := req.Header.Get("X-Monitor-Nonce")
	if err := client.authorizeRequest(req, body); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("X-Monitor-Nonce") == firstNonce {
		t.Fatal("nonce reused")
	}
}

func TestClosedRegistrationRecoversOnlyAnAlreadyAuthorizedIdentity(t *testing.T) {
	for _, mode := range []string{"lost_reply", "already_registered", "unknown", "conflict"} {
		t.Run(mode, func(t *testing.T) {
			c, err := NewConfig()
			if err != nil {
				t.Fatal(err)
			}
			c.Group, c.IdentityMode, c.Bootstrap, c.AllowLocalHTTP = "abcdefghijklmnop", "ed25519", true, true
			c.Invitation, c.Gate = "test-invitation", "must-not-be-sent"
			var registrations, lookups atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Monitor-Signature") == "" || r.Header.Get("X-Monitor-Node-ID") != c.NodeID || r.Header.Get("X-Monitor-Gate") != "" {
					t.Error("invalid identity headers")
				}
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/bootstrap/enroll" {
					registrations.Add(1)
					if mode == "lost_reply" {
						connection, _, err := w.(http.Hijacker).Hijack()
						if err != nil {
							t.Error(err)
							return
						}
						connection.Close()
						return
					}
					if mode == "conflict" {
						w.WriteHeader(409)
						w.Write([]byte(`{"code":"identity_conflict"}`))
						return
					}
					w.WriteHeader(403)
					w.Write([]byte(`{"code":"registration_closed"}`))
					return
				}
				if r.URL.Path != "/bootstrap/status" {
					t.Error("unexpected request path", r.URL.Path)
				}
				lookups.Add(1)
				if mode == "unknown" {
					w.WriteHeader(403)
					w.Write([]byte(`{"code":"revoked"}`))
					return
				}
				w.Write([]byte(`{"state":"approved","transport":"websocket","interval_seconds":600}`))
			}))
			defer server.Close()
			c.Server = server.URL
			client, err := NewClient(c)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			result, err := client.Join(context.Background(), "", HostInfo{})
			if mode == "unknown" || mode == "conflict" {
				if err == nil {
					t.Fatal("unregistered/conflicting identity recovered as approved")
				}
			} else if err != nil || result.State != "approved" {
				t.Fatal("lost reply did not recover", err)
			}
			if registrations.Load() != 1 {
				t.Fatal("registration was retried")
			}
			wanted := int32(1)
			if mode == "conflict" {
				wanted = 0
			}
			if lookups.Load() != wanted {
				t.Fatal("incorrect status recovery count")
			}
		})
	}
}

func TestJoinURLKeepsCredentialsOutOfNetworkURL(t *testing.T) {
	server, invitation, err := ParseJoinServer("https://monitor.example.com/#invite=abc%2B123&gate=shared")
	if err != nil || server != "https://monitor.example.com" || invitation != "abc+123" {
		t.Fatalf("bad parsing: %v", err)
	}
	for _, value := range []string{"https://monitor.example.com/#invite=one&invite=two", "https://monitor.example.com/?invite=unsafe", "https://monitor.example.com/#gate=bad%0Aheader"} {
		if _, _, err := ParseJoinServer(value); err == nil {
			t.Fatal("accepted unsafe URL")
		}
	}
}
