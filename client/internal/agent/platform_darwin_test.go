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
	// XNU rate-limits non-platform host_statistics callers in one-second
	// windows, returning cached HOST_CPU_LOAD_INFO after 2–10 requests. A
	// 50 ms sample after earlier tests can legitimately repeat the baseline.
	// Cross that native cache window instead of assuming every call is fresh.
	// https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/host.c
	time.Sleep(1100 * time.Millisecond)
	s := collector.Collect(time.Now())
	if s.CPUPercent == nil || *s.CPUPercent < 0 || *s.CPUPercent > 100 {
		t.Fatalf("native CPU delta unavailable or invalid: %v", s.CPUPercent)
	}
	if s.CPU == nil || s.CPU.User == nil || s.CPU.System == nil || s.CPU.Idle == nil {
		t.Fatal("native CPU category deltas unavailable")
	}
	for _, value := range []*float64{s.CPU.User, s.CPU.System, s.CPU.Idle} {
		if *value < 0 || *value > 100 {
			t.Fatalf("native CPU category outside percentage range: %f", *value)
		}
	}
}
