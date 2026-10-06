package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

var procMemoryFixture = []byte(`MemTotal: 16384000 kB
MemFree: 4096000 kB
MemAvailable: 8192000 kB
Buffers: 102400 kB
Cached: 2048000 kB
SwapTotal: 4096000 kB
SwapFree: 4000000 kB
Shmem: 1024 kB
SReclaimable: 51200 kB
` + strings.Repeat("UnusedField: 12345 kB\n", 40))

func BenchmarkParseMemory(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		if _, err := parseMemory(procMemoryFixture); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkParseNetworks(b *testing.B) {
	var fixture strings.Builder
	for i := range MaxInterfaces {
		fmt.Fprintf(&fixture, "eth%d: 4294967300 0 0 0 0 0 0 0 8589934600 0 0 0 0 0 0 0\n", i)
	}
	data := []byte(fixture.String())
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := parseNetworks(data, Config{}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkReleaseValidation(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		if !validReleasePlatform("windows", "amd64") || !validAssetFile("spider-watch-windows-amd64.exe") {
			b.Fatal("invalid target")
		}
	}
}

func BenchmarkSnapshot(b *testing.B) {
	for _, count := range []int{1, 4, 16} {
		b.Run(fmt.Sprint(count), func(b *testing.B) {
			raw := rawMetrics{cpu: &cpuCounters{total: 1000, idle: 100}, networks: make([]networkCounters, count)}
			for i := range count {
				raw.networks[i] = networkCounters{fmt.Sprintf("eth%d", i), 1000, 2000}
			}
			c := &Collector{}
			now := time.Unix(1700000000, 0)
			c.snapshot(raw, now)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				now = now.Add(5 * time.Second)
				c.snapshot(raw, now)
			}
		})
	}
}

func benchmarkLiveMetrics() LiveMetrics {
	return LiveMetrics{Type: "metrics", Sequence: 2, Metrics: Snapshot{
		Time: time.Unix(1700000000, 0).UTC(), Memory: &MemoryMetrics{Total: 1 << 30, Used: 1 << 29, Available: 1 << 29},
		Disks:    []DiskMetrics{{Mount: "/", Total: 1 << 40, Used: 1 << 39}},
		Networks: []NetworkMetrics{{Name: "eth0", RXBytes: 10000, TXBytes: 20000}},
	}}
}

func BenchmarkLiveJSONMarshal(b *testing.B) {
	report := benchmarkLiveMetrics()
	b.ReportAllocs()
	for b.Loop() {
		if _, err := json.Marshal(report); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLiveJSONReuse(b *testing.B) {
	report := benchmarkLiveMetrics()
	var encoder reportEncoder
	if _, err := encoder.encode(report); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := encoder.encode(report); err != nil {
			b.Fatal(err)
		}
	}
}
