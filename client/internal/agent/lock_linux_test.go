//go:build linux

package agent

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestAcquireLockRejectsSymlinkWithoutChangingTarget(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(t.TempDir(), "unrelated-private-file")
	content := []byte("must remain unchanged")
	if err := os.WriteFile(target, content, 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(target, filepath.Join(root, "run.lock")); err != nil {
		t.Fatal(err)
	}
	lock, err := AcquireLock(filepath.Join(root, "config.json"))
	if err == nil {
		lock.Close()
		t.Fatal("symbolic link accepted as agent lock")
	}
	assertLinuxFileUnchanged(t, target, before, content)
}

func TestAcquireLockRejectsNonRegularFile(t *testing.T) {
	root := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(root, "run.lock"), 0600); err != nil {
		t.Fatal(err)
	}
	lock, err := AcquireLock(filepath.Join(root, "config.json"))
	if err == nil {
		lock.Close()
		t.Fatal("FIFO accepted as agent lock")
	}
}
