//go:build linux || darwin

package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestRequestedUpdateMarkerIsEmptyIdempotentAndConsumed(t *testing.T) {
	state, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	for range 2 {
		if err = writeRequestedUpdateMarker(state); err != nil {
			t.Fatal(err)
		}
	}
	info, err := state.Lstat(remoteRequestMarker)
	if err != nil || info.Size() != 0 || info.Mode().Perm() != 0600 {
		t.Fatal("marker contains data or has excessive permissions")
	}
	if err = consumeRequestedUpdateMarker(state); err != nil {
		t.Fatal(err)
	}
	if err = consumeRequestedUpdateMarker(state); err == nil {
		t.Fatal("requested updater may run without a request")
	}
}

func TestRequestedUpdateMarkerCannotModifyLinkedOrPayloadFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "payload"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			state, err := os.OpenRoot(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer state.Close()
			target := filepath.Join(t.TempDir(), "untouched")
			payload := []byte("must not change")
			if kind == "hardlink" {
				payload = nil
			}
			if err = os.WriteFile(target, payload, 0600); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(dir, remoteRequestMarker)
			switch kind {
			case "symlink":
				err = os.Symlink(target, marker)
			case "hardlink":
				err = os.Link(target, marker)
			default:
				err = os.WriteFile(marker, payload, 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = writeRequestedUpdateMarker(state); err == nil {
				t.Fatal("accepted unsafe pending marker")
			}
			if err = consumeRequestedUpdateMarker(state); err == nil {
				t.Fatal("accepted unsafe marker for an update")
			}
			data, err := os.ReadFile(target)
			if err != nil || string(data) != string(payload) {
				t.Fatal("modified marker link target")
			}
			if _, err = os.Lstat(marker); !os.IsNotExist(err) {
				t.Fatal("did not clear malformed request")
			}
		})
	}
}

func TestRemoteUpdateRejectsPortableConfig(t *testing.T) {
	if err := TriggerRemoteUpdate(context.Background(), filepath.Join(t.TempDir(), "config.json")); err == nil {
		t.Fatal("accepted portable config")
	}
}
