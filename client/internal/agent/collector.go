package agent

import (
	"os"
	"runtime"
	"time"
)

type cpuCounters struct {
	total, idle, user, system, wait, steal uint64
	detailed, hasWait, hasSteal            bool
}
type networkCounters struct {
	name   string
	rx, tx uint64
}
type rawMetrics struct {
	cpu         *cpuCounters
	memory      *MemoryMetrics
	uptime      *float64
	disks       []DiskMetrics
	networks    []networkCounters
	unavailable []string
}

type Collector struct {
	config       Config
	previousCPU  *cpuCounters
	previousNet  []networkCounters
	previousTime time.Time
	host         HostInfo
}

func NewCollector(c Config, version string) *Collector {
	hostname, _ := os.Hostname()
	if len(hostname) > 128 {
		hostname = hostname[:128]
	}
	return &Collector{
		config: c,
		host: HostInfo{Hostname: hostname, OS: runtime.GOOS, Arch: runtime.GOARCH,
			Kernel: kernelVersion(), CPUs: runtime.NumCPU(), CPUModel: sanitizeCPUModel(cpuModel()), PhysicalCPUs: physicalCPUs(), Version: version},
	}
}

func (c *Collector) Host() HostInfo { return c.host }

func (c *Collector) Collect(now time.Time) Snapshot {
	raw := collectPlatform(c.config)
	s := c.snapshot(raw, now)
	s.RSSBytes, _ = ProcessRSS()
	s.Goroutines = runtime.NumGoroutine()
	return s
}

func (c *Collector) snapshot(raw rawMetrics, now time.Time) Snapshot {
	s := Snapshot{Time: now.UTC(), Memory: raw.memory, Uptime: raw.uptime,
		Disks: raw.disks, Networks: make([]NetworkMetrics, 0, len(raw.networks)),
		Unavailable: raw.unavailable}
	if c.previousCPU != nil && raw.cpu != nil {
		s.CPUPercent = cpuUsage(*c.previousCPU, *raw.cpu)
		if raw.cpu.detailed && c.previousCPU.detailed && s.CPUPercent != nil {
			s.CPU = cpuDetails(*c.previousCPU, *raw.cpu)
		}
	}
	seconds := now.Sub(c.previousTime).Seconds()
	for _, n := range raw.networks {
		s.Networks = append(s.Networks, NetworkMetrics{Name: n.name, RXBytes: n.rx, TXBytes: n.tx})
		metric := &s.Networks[len(s.Networks)-1]
		// At most 16 interfaces: retain the previous counters directly rather
		// than allocate and populate a new hash table for every report.
		for i := len(c.previousNet) - 1; i >= 0 && seconds > 0; i-- {
			prev := c.previousNet[i]
			if prev.name != n.name {
				continue
			}
			if n.rx >= prev.rx && n.tx >= prev.tx {
				metric.rxRate, metric.txRate = float64(n.rx-prev.rx)/seconds, float64(n.tx-prev.tx)/seconds
				metric.RXPerSec, metric.TXPerSec = &metric.rxRate, &metric.txRate
			} else {
				metric.CounterReset = true
			}
			break
		}
	}
	c.previousCPU, c.previousNet, c.previousTime = raw.cpu, raw.networks, now
	return s
}

func cpuUsage(old, current cpuCounters) *float64 {
	if current.total <= old.total || current.idle < old.idle {
		return nil
	}
	total, idle := current.total-old.total, current.idle-old.idle
	if idle > total {
		return nil
	}
	p := float64(total-idle) * 100 / float64(total)
	return &p
}

func wantedInterface(c Config, name string) bool {
	if len(c.Interfaces) == 0 {
		return name != "lo" && name != "Loopback Pseudo-Interface 1"
	}
	for _, allowed := range c.Interfaces {
		if allowed == name {
			return true
		}
	}
	return false
}

func cpuDetails(old, current cpuCounters) *CPUDetails {
	if current.total <= old.total {
		return nil
	}
	delta := current.total - old.total
	percent := func(before, after uint64) *float64 {
		if delta == 0 || after < before || after-before > delta {
			return nil
		}
		value := float64(after-before) * 100 / float64(delta)
		return &value
	}
	result := &CPUDetails{User: percent(old.user, current.user), System: percent(old.system, current.system)}
	if old.idle >= old.wait && current.idle >= current.wait {
		result.Idle = percent(old.idle-old.wait, current.idle-current.wait)
	}
	if old.hasWait && current.hasWait {
		result.IOWait = percent(old.wait, current.wait)
	}
	if old.hasSteal && current.hasSteal {
		result.Steal = percent(old.steal, current.steal)
	}
	return result
}
func uintValue(value uint64) *uint64 { return &value }
