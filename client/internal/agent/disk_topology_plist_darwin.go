//go:build darwin

package agent

import (
	"encoding/xml"
	"errors"
	"io"
	"strconv"
)

// diskutil's plist output is its machine-readable API. Parse a bounded subset
// instead of depending on localized text or inferring APFS parents from names.
type diskPlist struct {
	dict  map[string]diskPlist
	array []diskPlist
	text  string
}

// Immutable metadata shared by every volume/snapshot in one APFS container.
// Pool use is Total-Available; a volume's own statfs Used excludes other volumes.
type apfsPool struct {
	Group            string
	Total, Available uint64
	Known            bool
}

func apfsPoolPlist(data diskPlist) map[string]*apfsPool {
	rows := make(map[string]*apfsPool)
	for _, container := range data.dict["Containers"].array {
		id := container.dict["ContainerReference"].text
		if id == "" || len(id) > 120 {
			continue
		}
		pool := &apfsPool{Group: "apfs:" + id}
		total, totalErr := strconv.ParseUint(container.dict["CapacityCeiling"].text, 10, 64)
		available, availableErr := strconv.ParseUint(container.dict["CapacityFree"].text, 10, 64)
		if totalErr == nil && availableErr == nil && total > 0 && available <= total {
			pool.Total, pool.Available, pool.Known = total, available, true
		}
		rows[id] = pool
		for _, volume := range container.dict["Volumes"].array {
			if name := volume.dict["DeviceIdentifier"].text; name != "" {
				rows[name] = pool
			}
		}
	}
	return rows
}

func applyAPFSPool(volume *DiskMetrics, pool *apfsPool) {
	if pool == nil {
		return
	}
	volume.CapacityGroup = pool.Group
	if pool.Known {
		volume.PoolTotal, volume.PoolAvailable = &pool.Total, &pool.Available
	}
}

func decodeDiskPlist(reader io.Reader) (diskPlist, error) {
	d := xml.NewDecoder(io.LimitReader(reader, 1<<20))
	var value func(xml.StartElement, int) (diskPlist, error)
	nodes := 0
	value = func(start xml.StartElement, depth int) (diskPlist, error) {
		nodes++
		if depth > 12 || nodes > 16384 {
			return diskPlist{}, errors.New("disk plist exceeds limit")
		}
		var row diskPlist
		switch start.Name.Local {
		case "dict":
			row.dict = make(map[string]diskPlist)
			key := ""
			for {
				token, err := d.Token()
				if err != nil {
					return row, err
				}
				switch t := token.(type) {
				case xml.EndElement:
					return row, nil
				case xml.StartElement:
					v, err := value(t, depth+1)
					if err != nil {
						return row, err
					}
					if t.Name.Local == "key" {
						key = v.text
					} else {
						if key == "" {
							return row, errors.New("invalid disk plist")
						}
						row.dict[key] = v
						key = ""
					}
				}
			}
		case "array":
			for {
				token, err := d.Token()
				if err != nil {
					return row, err
				}
				switch t := token.(type) {
				case xml.EndElement:
					return row, nil
				case xml.StartElement:
					v, err := value(t, depth+1)
					if err != nil {
						return row, err
					}
					row.array = append(row.array, v)
				}
			}
		default:
			err := d.DecodeElement(&row.text, &start)
			return row, err
		}
	}
	for {
		token, err := d.Token()
		if err != nil {
			return diskPlist{}, err
		}
		if start, ok := token.(xml.StartElement); ok && start.Name.Local == "dict" {
			return value(start, 0)
		}
	}
}

func physicalDiskPlist(data diskPlist) map[string][]PhysicalDisk {
	rows := make(map[string][]PhysicalDisk)
	for _, disk := range data.dict["AllDisksAndPartitions"].array {
		id := disk.dict["DeviceIdentifier"].text
		size, _ := strconv.ParseUint(disk.dict["Size"].text, 10, 64)
		if id == "" || len(id) > 128 {
			continue
		}
		parent := []PhysicalDisk{{ID: id, Name: "/dev/" + id, Size: size}}
		rows[id] = parent
		for _, partition := range disk.dict["Partitions"].array {
			if name := partition.dict["DeviceIdentifier"].text; name != "" {
				rows[name] = parent
			}
		}
	}
	return rows
}

func addAPFSPhysicalDisks(rows map[string][]PhysicalDisk, data diskPlist) {
	for _, container := range data.dict["Containers"].array {
		var disks []PhysicalDisk
		complete := len(container.dict["PhysicalStores"].array) > 0
		stores := container.dict["PhysicalStores"].array
		if len(stores) > maxBackingDisks {
			continue
		}
		for _, store := range stores {
			backing := rows[store.dict["DeviceIdentifier"].text]
			if len(backing) == 0 {
				complete = false
				break
			}
			for _, disk := range backing {
				disks = appendPhysicalDisk(disks, disk)
			}
		}
		if !complete || len(disks) == 0 {
			continue
		}
		if name := container.dict["ContainerReference"].text; name != "" {
			rows[name] = disks
		}
		for _, volume := range container.dict["Volumes"].array {
			if name := volume.dict["DeviceIdentifier"].text; name != "" {
				rows[name] = disks
			}
		}
	}
}
