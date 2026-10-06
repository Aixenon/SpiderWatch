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
	"testing"

	"spiderwatch/client/internal/agent"
)

func TestCLIStatusBeforeAccessProvisioningDoesNotLeakCredentials(t *testing.T) {
	for _, state := range []string{"pending", "approved"} {
		t.Run(state, func(t *testing.T) {
			config, err := agent.NewConfig()
			if err != nil {
				t.Fatal(err)
			}
			config.Bootstrap, config.Group = true, "100000000001"
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/bootstrap/status" {
					t.Error("unprovisioned status used the protected Access endpoint")
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				if r.Header.Get("Authorization") != "Bearer "+config.DeviceKey || r.Header.Get("X-Monitor-Node-ID") != config.NodeID {
					t.Error("bootstrap status omitted the independent device identity")
				}
				if r.Header.Get("CF-Access-Client-Id") != "" || r.Header.Get("CF-Access-Client-Secret") != "" {
					t.Error("bootstrap status unexpectedly required Access credentials")
				}
				w.Header().Set("Content-Type", "application/json")
				if state == "approved" {
					fmt.Fprint(w, `{"state":"approved","access":{"client_id":"private-access-id","client_secret":"private-access-secret"}}`)
				} else {
					fmt.Fprint(w, `{"state":"pending"}`)
				}
			}))
			defer server.Close()
			root := t.TempDir()
			config.Server, config.CAFile = server.URL, filepath.Join(root, "ca.pem")
			if err = os.WriteFile(config.CAFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, "config.json")
			if err = agent.SaveConfig(path, config); err != nil {
				t.Fatal(err)
			}
			var out, errOut bytes.Buffer
			if err = execute(context.Background(), []string{"status", "--config", path}, &out, &errOut); err != nil {
				t.Fatal(err)
			}
			var result map[string]string
			if err = json.Unmarshal(out.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if len(result) != 3 || result["node_id"] != config.NodeID || result["group"] != config.Group || result["state"] != state {
				t.Fatal("status did not return only node_id, group and state")
			}
			output := out.String() + errOut.String()
			for _, secret := range []string{config.DeviceKey, "private-access-id", "private-access-secret"} {
				if strings.Contains(output, secret) {
					t.Fatal("status leaked a device or Access credential")
				}
			}
		})
	}
}
