//go:build linux

package agent

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
)

var mountEscapes = strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)

func collectVolumes(c Config) []DiskMetrics {
	rows := make([]DiskMetrics, 0, 4)
	add := func(mount, source, filesystem, majorMinor string) {
		var stat syscall.Statfs_t
		if syscall.Statfs(mount, &stat) != nil || stat.Blocks == 0 {
			return
		}
		id := strconv.FormatUint(uint64(uint32(stat.Fsid.X__val[0])), 16) + ":" + strconv.FormatUint(uint64(uint32(stat.Fsid.X__val[1])), 16)
		if id == "0:0" {
			id = source
		}
		block := uint64(stat.Bsize)
		rows = appendVolume(rows, DiskMetrics{VolumeID: id, Device: source, Filesystem: filesystem, Mount: mount, PhysicalDisks: linuxBackingDisks(majorMinor),
			Total: stat.Blocks * block, Available: stat.Bavail * block, Used: (stat.Blocks - stat.Bfree) * block})
	}
	if file, err := os.Open("/proc/self/mountinfo"); err == nil {
		defer file.Close()
		s := bufio.NewScanner(file)
		for s.Scan() {
			left, right, ok := strings.Cut(s.Text(), " - ")
			if !ok {
				continue
			}
			a, b := strings.Fields(left), strings.Fields(right)
			if len(a) < 5 || len(b) < 2 {
				continue
			}
			mount, source := mountEscapes.Replace(a[4]), mountEscapes.Replace(b[1])
			// Real block devices and the container root. Exclude tmpfs, proc,
			// cgroups, bind-mounted regular files and remote pseudo-filesystems.
			if !strings.HasPrefix(source, "/dev/") && !(mount == "/" && b[0] == "overlay") {
				continue
			}
			if info, err := os.Stat(mount); err != nil || !info.IsDir() {
				continue
			}
			add(mount, source, b[0], a[2])
		}
	}
	if len(rows) == 0 {
		for _, mount := range c.Mounts {
			add(mount, mount, "", "")
		}
	}
	return rows
}

func physicalCPUs() int {
	file, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return 0
	}
	defer file.Close()
	cores := make(map[string]struct{})
	packageID, coreID := "", ""
	s := bufio.NewScanner(file)
	add := func() {
		if packageID != "" && coreID != "" {
			cores[packageID+":"+coreID] = struct{}{}
		}
		packageID, coreID = "", ""
	}
	for s.Scan() {
		if s.Text() == "" {
			add()
			continue
		}
		key, value, ok := strings.Cut(s.Text(), ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "physical id":
			packageID = strings.TrimSpace(value)
		case "core id":
			coreID = strings.TrimSpace(value)
		}
		if len(cores) > 65536 {
			return 0
		}
	}
	add()
	return len(cores)
}
