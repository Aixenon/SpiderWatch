//go:build linux

package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSysfsPhysicalTopologyIncludesAllLVMBackings(t *testing.T) {
	root := t.TempDir()
	write := func(path, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	first := filepath.Join(root, "devices/pci0000/block/nvme0n1")
	second := filepath.Join(root, "devices/pci0001/block/sda")
	dm := filepath.Join(root, "devices/virtual/block/dm-0")
	write(filepath.Join(first, "size"), "2000")
	write(filepath.Join(first, "nvme0n1p2/partition"), "2")
	write(filepath.Join(second, "size"), "3000")
	write(filepath.Join(second, "sda9/partition"), "9")
	if err := os.MkdirAll(filepath.Join(dm, "slaves"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{"nvme0n1p2": filepath.Join(first, "nvme0n1p2"), "sda9": filepath.Join(second, "sda9")} {
		if err := os.Symlink(target, filepath.Join(dm, "slaves", name)); err != nil {
			t.Fatal(err)
		}
	}
	got := readLinuxBackingDisks(root, dm)
	if len(got) != 2 {
		t.Fatalf("LVM backing topology: %+v", got)
	}
	var capacity uint64
	for _, disk := range got {
		capacity += disk.Size
		if disk.ID == "dm-0" {
			t.Fatal("virtual disk misidentified as physical")
		}
	}
	if capacity != 5000*512 {
		t.Fatalf("physical sector capacity %d", capacity)
	}
	partition := readLinuxBackingDisks(root, filepath.Join(first, "nvme0n1p2"))
	if len(partition) != 1 || partition[0].ID != "nvme0n1" {
		t.Fatalf("partition parent: %v", partition)
	}
	if err := os.Remove(filepath.Join(dm, "slaves", "sda9")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "missing"), filepath.Join(dm, "slaves", "sda9")); err != nil {
		t.Fatal(err)
	}
	if readLinuxBackingDisks(root, dm) != nil {
		t.Fatal("partial topology claimed as complete")
	}
	loop := filepath.Join(root, "devices/virtual/block/loop0")
	write(filepath.Join(loop, "size"), "2000")
	if readLinuxBackingDisks(root, loop) != nil {
		t.Fatal("loop file claimed as physical disk")
	}
}
