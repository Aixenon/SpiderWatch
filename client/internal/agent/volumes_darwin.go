//go:build darwin

package agent

import (
	"strconv"
	"strings"
	"syscall"
)

func statName(value []int8) string {
	b := make([]byte, 0, len(value))
	for _, c := range value {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}
func collectVolumes(c Config) []DiskMetrics {
	count, err := syscall.Getfsstat(nil, 2) // MNT_NOWAIT: never force filesystem I/O.
	if err != nil || count < 1 {
		return []DiskMetrics{}
	}
	if count > 1024 {
		count = 1024
	}
	stats := make([]syscall.Statfs_t, count)
	n, err := syscall.Getfsstat(stats, 2)
	if err != nil {
		return []DiskMetrics{}
	}
	rows := make([]DiskMetrics, 0, 4)
	for _, s := range stats[:min(n, len(stats))] {
		source, mount, fs := statName(s.Mntfromname[:]), statName(s.Mntonname[:]), statName(s.Fstypename[:])
		if !strings.HasPrefix(source, "/dev/") || s.Blocks == 0 {
			continue
		}
		group := ""
		if fs == "apfs" {
			// APFS volumes share a container's free space; aggregate the pool
			// once instead of multiplying its capacity by the volume count.
			device := strings.TrimPrefix(source, "/dev/disk")
			if i := strings.IndexByte(device, 's'); i > 0 {
				group = "apfs:disk" + device[:i]
			}
		}
		id := strconv.FormatUint(uint64(uint32(s.Fsid.Val[0])), 16) + ":" + strconv.FormatUint(uint64(uint32(s.Fsid.Val[1])), 16)
		block := uint64(s.Bsize)
		disks, pool := darwinVolumeInfo(source)
		volume := DiskMetrics{VolumeID: id, Device: source, Mount: mount, Filesystem: fs, CapacityGroup: group, PhysicalDisks: disks,
			Total: s.Blocks * block, Available: s.Bavail * block, Used: (s.Blocks - s.Bfree) * block}
		applyAPFSPool(&volume, pool)
		rows = appendVolume(rows, volume)
	}
	return rows
}
