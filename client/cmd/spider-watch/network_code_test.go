package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"spiderwatch/client/internal/agent"
)

func TestConfigureJoinCodeCasePreservesIdentityAndApproval(t *testing.T) {
	t.Setenv("CF_ACCESS_CLIENT_ID", "")
	t.Setenv("CF_ACCESS_CLIENT_SECRET", "")
	var previous agent.JoinRequest
	joins := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bootstrap/enroll" {
			t.Error("unexpected enrollment path", r.URL.Path)
		}
		var join agent.JoinRequest
		if err := json.NewDecoder(r.Body).Decode(&join); err != nil {
			t.Error(err)
		}
		if join.Group != "a1b2c3d4e5f6g7h8" {
			t.Error("network code was not normalized", join.Group)
		}
		if joins > 0 && (join.NodeID != previous.NodeID || join.DeviceKey != previous.DeviceKey) {
			t.Error("changing code case replaced the identity")
		}
		previous = join
		joins++
		state := "pending"
		if joins > 1 {
			state = "approved"
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"state":%q,"transport":"websocket","interval_seconds":60}`, state)
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "config.json")
	command := func(code string) (string, error) {
		t.Helper()
		var output bytes.Buffer
		err := execute(context.Background(), []string{"configure", "--server", server.URL, "--join", code, "--allow-local-http", "--config", path}, &output, &output)
		return output.String(), err
	}
	if _, err := command("A1B2C3D4E5F6G7H8"); err != nil {
		t.Fatal(err)
	}
	initial, err := agent.LoadConfig(path)
	if err != nil || initial.Group != "a1b2c3d4e5f6g7h8" {
		t.Fatal("new code was not saved as a string", err)
	}
	for _, code := range []string{"a1b2c3d4e5f6g7h8", "A1B2C3D4E5F6G7H8"} {
		result, err := command(code)
		if err != nil || !bytes.Contains([]byte(result), []byte(`"state":"approved"`)) {
			t.Fatal("same network required approval again", result, err)
		}
	}
	for _, code := range []string{"short", "abcdefghijklmno-", ""} {
		if _, err := command(code); err == nil {
			t.Error("incorrect network code was accepted", code)
		}
	}
	final, err := agent.LoadConfig(path)
	if err != nil || final.Group != initial.Group || final.NodeID != initial.NodeID || final.DeviceKey != initial.DeviceKey || joins != 3 {
		t.Fatal("rejected network code changed the stored membership", err)
	}
}
