package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestResourceCPUCounters(t *testing.T) {
	before, err := parseCPU([]byte("cpu 100 20 30 400 10 5 5 10 99 99"))
	if err != nil {
		t.Fatal(err)
	}
	after, err := parseCPU([]byte("cpu 120 20 40 460 15 5 5 15 199 199"))
	if err != nil {
		t.Fatal(err)
	}
	d := cpuDetails(*before, *after)
	if d == nil || *d.User != 20 || *d.System != 10 || *d.Idle != 60 || *d.IOWait != 5 || *d.Steal != 5 || *cpuUsage(*before, *after) != 35 {
		t.Fatalf("CPU categories double count guest or I/O wait: %+v", d)
	}
	if cpuDetails(*after, *before) != nil {
		t.Fatal("reset must not wrap counters")
	}
	after.wait = 9 // Linux may report an iowait counter decrease.
	if cpuDetails(*before, *after).IOWait != nil {
		t.Fatal("decreasing iowait must be unavailable")
	}
}

func TestResourceMemoryCounters(t *testing.T) {
	m, err := parseMemory([]byte("MemTotal: 1000 kB\nMemAvailable: 600 kB\nMemFree: 0 kB\nCached: 100 kB\nSReclaimable: 50 kB\nCommitted_AS: 3000 kB\nCommitLimit: 1500 kB\nSwapTotal: 500 kB\nSwapFree: 400 kB\n"))
	if err != nil {
		t.Fatal(err)
	}
	if m.Free == nil || *m.Free != 0 || m.Buffers != nil || m.Wired != nil || *m.Cached != 150*1024 || m.Used != 400*1024 || m.SwapUsed != 100*1024 || *m.Committed != 3000*1024 {
		t.Fatalf("missing/zero counters, reclaimable cache or virtual memory mixed: %+v", m)
	}
	b, _ := json.Marshal(m)
	if strings.Contains(string(b), "buffers_bytes") || !strings.Contains(string(b), `"free_bytes":0`) {
		t.Fatal("optional field semantics changed")
	}
}

func TestResourceVolumesDeduplicateMountAliases(t *testing.T) {
	rows := appendVolume(nil, DiskMetrics{VolumeID: "same-volume", Device: "/dev/sda1", Mount: "/mnt/alias", Total: 100, Used: 20})
	rows = appendVolume(rows, DiskMetrics{VolumeID: "same-volume", Device: "/dev/root", Mount: "/", Total: 100, Used: 20})
	rows = appendVolume(rows, DiskMetrics{VolumeID: "other-volume", Device: "/dev/sda2", Mount: "/data", Total: 200, Used: 30})
	if len(rows) != 2 || rows[0].Mount != "/" || rows[0].MountCount != 2 || rows[0].Total != 100 {
		t.Fatalf("aliases became extra disks: %+v", rows)
	}
	if len(appendVolume(rows, DiskMetrics{VolumeID: "inaccessible"})) != 2 {
		t.Fatal("unreadable volume included")
	}
	if len(appendVolume(rows, DiskMetrics{VolumeID: "invalid", Total: 1, Used: 2})) != 2 {
		t.Fatal("invalid capacity included")
	}
}

func TestVolumeAliasRetainsKnownPoolCapacity(t *testing.T) {
	rows := appendVolume(nil, DiskMetrics{VolumeID: "same", Mount: "/alias", Total: 1000, Used: 100})
	rows = appendVolume(rows, DiskMetrics{VolumeID: "same", Mount: "/", Total: 1000, Used: 100, CapacityGroup: "apfs:disk3", PoolTotal: uintValue(1000), PoolAvailable: uintValue(250)})
	if len(rows) != 1 || rows[0].PoolTotal == nil || *rows[0].PoolAvailable != 250 || rows[0].CapacityGroup != "apfs:disk3" {
		t.Fatal("alias lost known container usage")
	}
}

func TestResourceReportFitsVolumeAndInterfaceBudget(t *testing.T) {
	report := benchmarkLiveMetrics()
	report.Metrics.Disks = nil
	for i := range MaxVolumes {
		report.Metrics.Disks = appendVolume(report.Metrics.Disks, DiskMetrics{VolumeID: fmt.Sprintf("volume-%d", i), Device: "/dev/mapper/" + strings.Repeat("d", 64), Label: strings.Repeat("l", 128), Filesystem: "ext4", Mount: "/" + strings.Repeat("m", 255), Total: 1 << 40, Used: 1 << 39, Available: 1 << 39, PoolTotal: uintValue(1 << 40), PoolAvailable: uintValue(1 << 39), PhysicalDisks: []PhysicalDisk{{ID: "nvme0n1", Name: "/dev/nvme0n1", Size: 1 << 40}}})
	}
	report.Metrics.Networks = nil
	for i := range MaxInterfaces {
		report.Metrics.Networks = append(report.Metrics.Networks, NetworkMetrics{Name: fmt.Sprintf("eth%d", i), RXBytes: 1 << 50, TXBytes: 1 << 50})
	}
	var encoder reportEncoder
	b, err := encoder.encode(report)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("32 volumes and 16 interfaces: %d bytes of %d-byte report budget", len(b), MaxRequestBytes)
}

func TestLargePhysicalTopologyKeepsResourceReportsWithinBudget(t *testing.T) {
	report := benchmarkLiveMetrics()
	report.Metrics.Disks = make([]DiskMetrics, MaxVolumes)
	for i := range report.Metrics.Disks {
		disk := &report.Metrics.Disks[i]
		disk.VolumeID, disk.Total, disk.Used = fmt.Sprint(i), 100, 20
		for j := range maxBackingDisks {
			disk.PhysicalDisks = append(disk.PhysicalDisks, PhysicalDisk{ID: fmt.Sprint(j) + strings.Repeat("i", 127), Name: strings.Repeat("n", 128), Size: 100})
		}
	}
	var encoder reportEncoder
	data, err := encoder.encode(report)
	if err != nil {
		t.Fatal(err)
	}
	var decoded LiveMetrics
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(data) > MaxRequestBytes || len(decoded.Metrics.Disks) != MaxVolumes || len(decoded.Metrics.Disks[0].PhysicalDisks) != 0 || len(report.Metrics.Disks[0].PhysicalDisks) != maxBackingDisks {
		t.Fatal("optional topology handling lost metrics or mutated the source")
	}
}
