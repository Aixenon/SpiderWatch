//go:build freebsd || openbsd

package agent

import (
	"errors"
	"syscall"
)

// These builds support the protocol and filesystem metrics. Native CPU, memory
// and network adapters need a tested implementation before production support.
func defaultMount() string  { return "/" }
func kernelVersion() string { v, _ := syscall.Sysctl("kern.osrelease"); return v }

func collectPlatform(c Config) rawMetrics {
	r := rawMetrics{disks: make([]DiskMetrics, 0, len(c.Mounts)), networks: []networkCounters{},
		unavailable: []string{"cpu", "memory", "uptime", "network", "agent_rss"}}
	for _, mount := range c.Mounts {
		var stat syscall.Statfs_t
		if syscall.Statfs(mount, &stat) != nil {
			r.unavailable = append(r.unavailable, "disk:"+mount)
			continue
		}
		available := uint64(0)
		if stat.Bavail > 0 {
			available = uint64(stat.Bavail) * uint64(stat.Bsize)
		}
		r.disks = append(r.disks, DiskMetrics{Mount: mount, Total: uint64(stat.Blocks) * uint64(stat.Bsize),
			Available: available, Used: uint64(stat.Blocks-stat.Bfree) * uint64(stat.Bsize)})
	}
	return r
}

func ProcessRSS() (uint64, error) { return 0, errors.New("native RSS adapter unavailable") }

func physicalCPUs() int { return 0 }

func cpuModel() string { return "" }
