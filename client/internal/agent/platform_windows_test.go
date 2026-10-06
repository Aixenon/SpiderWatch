//go:build windows

package agent

import (
	"testing"
	"time"
	"unsafe"
)

func TestWindowsNativeLayoutAndMetrics(t *testing.T) {
	if unsafe.Sizeof(ifRow2{}) != 1352 || unsafe.Offsetof(ifRow2{}.InOctets) != 1208 || unsafe.Offsetof(ifRow2{}.OutOctets) != 1280 {
		t.Fatal("Windows interface ABI layout mismatch")
	}
	wantSize, wantCommitOffset := uintptr(104), uintptr(8)
	if unsafe.Sizeof(uintptr(0)) == 4 {
		wantSize, wantCommitOffset = 56, 4
	}
	if unsafe.Sizeof(performanceInfo{}) != wantSize || unsafe.Offsetof(performanceInfo{}.CommitTotal) != wantCommitOffset {
		t.Fatal("Windows performance information ABI layout mismatch")
	}
	c, _ := NewConfig()
	collector := NewCollector(c, "test")
	if model := collector.Host().CPUModel; model == "" || len(model) > maxCPUModelBytes || model != sanitizeCPUModel(model) {
		t.Fatal("Windows read-only processor model is missing or not normalized")
	}
	first := collector.Collect(time.Now())
	if first.Memory == nil || first.Memory.Total == 0 || first.RSSBytes == 0 || len(first.Disks) == 0 {
		t.Fatalf("missing native metrics: %+v", first)
	}
	if first.Memory.Cached == nil || first.Memory.Committed == nil || first.Memory.CommitLimit == nil || collector.Host().PhysicalCPUs < 1 {
		t.Fatal("missing Windows memory/core details")
	}
	seen := make(map[string]bool)
	for _, volume := range first.Disks {
		if volume.VolumeID == "" || seen[volume.VolumeID] || volume.Used > volume.Total {
			t.Fatal("invalid or duplicate Windows volume")
		}
		seen[volume.VolumeID] = true
	}
	time.Sleep(100 * time.Millisecond)
	second := collector.Collect(time.Now())
	if second.CPUPercent == nil || *second.CPUPercent < 0 || *second.CPUPercent > 100 {
		t.Fatalf("CPU usage: %+v", second)
	}
	if second.CPU == nil || second.CPU.User == nil || second.CPU.System == nil || second.CPU.Idle == nil {
		t.Fatal("missing Windows CPU details")
	}
}
