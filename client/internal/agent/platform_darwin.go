//go:build darwin

package agent

import (
	"os"
	"syscall"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

// gopsutil uses native Mach/sysctl APIs without requiring a bundled C runtime.
// Only the Darwin build imports it; the Linux /proc fast path stays unchanged.
func defaultMount() string  { return "/" }
func kernelVersion() string { v, _ := syscall.Sysctl("kern.osrelease"); return v }
func AvailableMemory() (uint64, error) {
	v, err := mem.VirtualMemory()
	if err != nil {
		return 0, err
	}
	return v.Available, nil
}
func ProcessRSS() (uint64, error) {
	p, err := process.NewProcess(int32(os.Getpid()))
	if err != nil {
		return 0, err
	}
	v, err := p.MemoryInfo()
	if err != nil {
		return 0, err
	}
	return v.RSS, nil
}
func EnforceProcessLimit() error {
	return syscall.Setrlimit(syscall.RLIMIT_CORE, &syscall.Rlimit{Cur: 0, Max: 0})
}
func collectPlatform(c Config) rawMetrics {
	r := rawMetrics{disks: collectVolumes(c), networks: []networkCounters{}}
	if v, err := cpu.Times(false); err == nil && len(v) > 0 {
		x := v[0]
		r.cpu = &cpuCounters{total: uint64((x.User + x.System + x.Nice + x.Idle) * 1e6), idle: uint64(x.Idle * 1e6), user: uint64((x.User + x.Nice) * 1e6), system: uint64(x.System * 1e6), detailed: true}
	} else {
		r.unavailable = append(r.unavailable, "cpu")
	}
	if v, err := mem.VirtualMemory(); err == nil {
		r.memory = &MemoryMetrics{Total: v.Total, Available: v.Available, Used: v.Total - v.Available, Free: uintValue(v.Free), Active: uintValue(v.Active), Inactive: uintValue(v.Inactive), Wired: uintValue(v.Wired)}
		if swap, err := mem.SwapMemory(); err == nil {
			r.memory.SwapTotal = swap.Total
			r.memory.SwapUsed = swap.Used
			r.memory.SwapSupported = true
		}
	} else {
		r.unavailable = append(r.unavailable, "memory")
	}
	if v, err := host.Uptime(); err == nil {
		u := float64(v)
		r.uptime = &u
	} else {
		r.unavailable = append(r.unavailable, "uptime")
	}
	if rows, err := net.IOCounters(true); err == nil {
		for _, v := range rows {
			if v.Name != "lo0" && wantedInterface(c, v.Name) && len(r.networks) < MaxInterfaces {
				r.networks = append(r.networks, networkCounters{v.Name, v.BytesRecv, v.BytesSent})
			}
		}
	} else {
		r.unavailable = append(r.unavailable, "network")
	}
	return r
}
