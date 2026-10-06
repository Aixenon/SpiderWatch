//go:build linux

package agent

import (
	"bytes"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func assertLinuxFileUnchanged(t *testing.T, path string, before os.FileInfo, content []byte) {
	t.Helper()
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	beforeOwner, afterOwner := before.Sys().(*syscall.Stat_t), after.Sys().(*syscall.Stat_t)
	if after.Mode() != before.Mode() || afterOwner.Uid != beforeOwner.Uid || afterOwner.Gid != beforeOwner.Gid {
		t.Fatal("rejected operation changed target permissions or ownership")
	}
	afterContent, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(afterContent, content) {
		t.Fatal("rejected operation changed target contents:", err)
	}
}

func TestPrepareConfigOwnershipAllowsMissingFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := prepareConfigOwnership(path, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareConfigOwnership(path, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal("configuration without an existing run.lock:", err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("private configuration permissions changed:", err)
	}
}

func TestPrepareConfigOwnershipRestoresBothFiles(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("changing ownership requires root; only temporary files are used")
	}
	path := filepath.Join(t.TempDir(), "config.json")
	files := []string{path, filepath.Join(filepath.Dir(path), "run.lock")}
	for _, file := range files {
		if err := os.WriteFile(file, []byte("private"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := prepareConfigOwnership(path, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		info, err := os.Stat(file)
		if err != nil {
			t.Fatal(err)
		}
		owner := info.Sys().(*syscall.Stat_t)
		if owner.Uid != 65534 || owner.Gid != 65534 || info.Mode().Perm() != 0600 {
			t.Fatal("service ownership or private permissions not restored")
		}
	}
	if err := prepareConfigOwnership(path, 65534, 65534); err != nil {
		t.Fatal("already-correct ownership:", err)
	}
}

func TestPrepareConfigOwnershipRejectsSymlinks(t *testing.T) {
	for _, name := range []string{"config.json", "run.lock"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "config.json")
			if name != "config.json" {
				if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			target := filepath.Join(t.TempDir(), "unrelated-private-file")
			content := []byte("must remain unchanged")
			if err := os.WriteFile(target, content, 0640); err != nil {
				t.Fatal(err)
			}
			before, err := os.Stat(target)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.Symlink(target, filepath.Join(root, name)); err != nil {
				t.Fatal(err)
			}
			if err = prepareConfigOwnership(path, os.Getuid(), os.Getgid()); err == nil {
				t.Fatal("service file symbolic link accepted")
			}
			assertLinuxFileUnchanged(t, target, before, content)
		})
	}
}

func TestPrepareConfigOwnershipRejectsNonRegularFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareConfigOwnership(path, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("FIFO accepted as service configuration")
	}
}
