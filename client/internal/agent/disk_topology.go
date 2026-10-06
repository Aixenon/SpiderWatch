package agent

import (
	"sync"
	"time"
)

const maxBackingDisks = 8

// Topology changes much less often than usage. Cache immutable results (also
// unavailable results) briefly so normal samples need no extra device queries.
type diskTopologyCache struct {
	sync.Mutex
	entries map[string]diskTopologyEntry
}
type diskTopologyEntry struct {
	until time.Time
	disks []PhysicalDisk
}

func (c *diskTopologyCache) get(id string, read func() []PhysicalDisk) []PhysicalDisk {
	c.Lock()
	defer c.Unlock()
	now := time.Now()
	if entry, ok := c.entries[id]; ok && now.Before(entry.until) {
		return entry.disks
	}
	if c.entries == nil || len(c.entries) >= MaxVolumes*2 {
		c.entries = make(map[string]diskTopologyEntry)
	}
	disks := read()
	c.entries[id] = diskTopologyEntry{now.Add(time.Minute), disks}
	return disks
}

func appendPhysicalDisk(disks []PhysicalDisk, disk PhysicalDisk) []PhysicalDisk {
	if disk.ID == "" || disk.Name == "" {
		return disks
	}
	for _, row := range disks {
		if row.ID == disk.ID {
			return disks
		}
	}
	if len(disks) >= maxBackingDisks {
		return disks
	}
	disk.ID, disk.Name = boundedLabel(disk.ID, 128), boundedLabel(disk.Name, 128)
	return append(disks, disk)
}
