//go:build windows

package agent

import (
	"encoding/binary"
	"reflect"
	"testing"
)

func TestVolumeDiskExtentAlignmentAndDeduplication(t *testing.T) {
	data := make([]byte, 8+3*24)
	binary.LittleEndian.PutUint32(data, 3)
	for i, number := range []uint32{2, 7, 2} {
		binary.LittleEndian.PutUint32(data[8+i*24:], number)
		binary.LittleEndian.PutUint64(data[16+i*24:], 1234567890123)
		binary.LittleEndian.PutUint64(data[24+i*24:], 1000000000000)
	}
	if got := volumeDiskNumbers(data); !reflect.DeepEqual(got, []uint32{2, 7}) {
		t.Fatalf("Windows ABI decode: %v", got)
	}
	for _, truncated := range [][]byte{nil, data[:4], data[:len(data)-1]} {
		if volumeDiskNumbers(truncated) != nil {
			t.Fatal("accepted truncated extents")
		}
	}
	binary.LittleEndian.PutUint32(data, 0xffffffff)
	if volumeDiskNumbers(data) != nil {
		t.Fatal("accepted invalid extent count")
	}
}

func TestWindowsReadOnlyDiskTopology(t *testing.T) {
	c, _ := NewConfig()
	for _, volume := range collectVolumes(c) {
		for _, disk := range volume.PhysicalDisks {
			if disk.ID == "" || disk.Name == "" {
				t.Fatal("invalid physical disk")
			}
		}
		t.Logf("volume %s: %d readable backing disks", volume.Device, len(volume.PhysicalDisks))
	}
	// Permission-denied, unsupported or absent volumes are explicitly unknown.
	if got := windowsBackingDisks(`\\?\Volume{00000000-0000-0000-0000-000000000000}\`); len(got) != 0 {
		t.Fatalf("invented missing disk: %v", got)
	}
}
