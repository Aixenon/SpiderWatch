//go:build windows

package agent

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRequestedUpdateTaskUsesOnlyFixedHiddenCommand(t *testing.T) {
	command := requestedUpdateTaskCommand(context.Background(), `C:\Windows\System32`)
	want := []string{`C:\Windows\System32\schtasks.exe`, "/Run", "/TN", "spider-watch-update-request"}
	if !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("unexpected updater command: %q", command.Args)
	}
	if command.SysProcAttr == nil || !command.SysProcAttr.HideWindow || command.SysProcAttr.CreationFlags&0x08000000 == 0 {
		t.Fatal("update request can open a visible window")
	}
}

func TestRemoteUpdateRejectsPortableConfigWithoutLaunchingTask(t *testing.T) {
	if err := TriggerRemoteUpdate(context.Background(), filepath.Join(t.TempDir(), "config.json")); err == nil {
		t.Fatal("portable configuration was allowed to run the installed task")
	}
}

func TestRemoteWindowsPathRejectsNonRegularAndRedirectedEntries(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "config.json")
	if err := os.WriteFile(file, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateRemoteWindowsPath(file); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{dir, "relative.json", filepath.Join(dir, "missing")} {
		if err := validateRemoteWindowsPath(bad); err == nil {
			t.Fatalf("accepted invalid path %q", bad)
		}
	}
	alias := filepath.Join(dir, "alias.json")
	if err := os.Symlink(file, alias); err != nil {
		t.Skip("symbolic link creation unavailable")
	}
	if err := validateRemoteWindowsPath(alias); err == nil {
		t.Fatal("accepted symbolic link")
	}
}
