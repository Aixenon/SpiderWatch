//go:build darwin

package agent

import (
	"testing"
	"time"
)

func TestDarwinNativeMetrics(t *testing.T) {
	c, err := NewConfig()
	if err != nil {
		t.Fatal(err)
	}
	v := collectPlatform(c)
	if v.cpu == nil || v.memory == nil || v.memory.Total == 0 || v.uptime == nil || len(v.disks) == 0 {
		t.Fatalf("missing native metrics: %+v", v)
	}
	if rss, err := ProcessRSS(); err != nil || rss == 0 {
		t.Fatalf("RSS: %d %v", rss, err)
	}
	if available, err := AvailableMemory(); err != nil || available == 0 {
		t.Fatalf("RAM: %d %v", available, err)
	}
	collector := NewCollector(c, "test")
	collector.Collect(time.Now())
	time.Sleep(50 * time.Millisecond)
	if s := collector.Collect(time.Now()); s.CPUPercent == nil {
		t.Fatal("CPU delta unavailable")
	}
}
