package agent

import "strings"

const MaxVolumes = 32

// A filesystem/volume appears once even when it has several mount points.
// Only its shortest mount is carried as a secondary label, not as a device.
func appendVolume(rows []DiskMetrics, volume DiskMetrics) []DiskMetrics {
	if volume.Total == 0 || volume.VolumeID == "" || volume.Used > volume.Total {
		return rows
	}
	for i := range rows {
		if rows[i].VolumeID == volume.VolumeID {
			rows[i].MountCount++
			if len(rows[i].PhysicalDisks) == 0 {
				rows[i].PhysicalDisks = volume.PhysicalDisks
			}
			if rows[i].PoolTotal == nil && volume.PoolTotal != nil && volume.PoolAvailable != nil {
				rows[i].CapacityGroup = volume.CapacityGroup
				rows[i].PoolTotal, rows[i].PoolAvailable = volume.PoolTotal, volume.PoolAvailable
			}
			if len(volume.Mount) < len(rows[i].Mount) {
				rows[i].Mount = volume.Mount
			}
			return rows
		}
	}
	if len(rows) >= MaxVolumes {
		return rows
	}
	volume.MountCount = 1
	volume.VolumeID = boundedLabel(volume.VolumeID, 256)
	volume.Mount = boundedLabel(volume.Mount, 256)
	volume.Device = boundedLabel(volume.Device, 128)
	volume.Label = boundedLabel(volume.Label, 128)
	volume.Filesystem = boundedLabel(volume.Filesystem, 32)
	volume.CapacityGroup = boundedLabel(volume.CapacityGroup, 128)
	return append(rows, volume)
}

func boundedLabel(value string, limit int) string {
	if len(value) > limit {
		value = value[:limit]
	}
	return strings.ToValidUTF8(value, "�")
}
