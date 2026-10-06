//go:build linux

package agent

import (
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var linuxDiskTopology diskTopologyCache

func linuxBackingDisks(majorMinor string) []PhysicalDisk {
	if majorMinor == "" || strings.ContainsAny(majorMinor, `/\\`) {
		return nil
	}
	return linuxDiskTopology.get(majorMinor, func() []PhysicalDisk {
		return readLinuxBackingDisks("/sys", filepath.Join("/sys/dev/block", majorMinor))
	})
}

func readLinuxBackingDisks(root, start string) []PhysicalDisk {
	var rows []PhysicalDisk
	visited := make(map[string]uint8)
	var walk func(string, int) bool
	walk = func(path string, depth int) bool {
		if depth > 12 || len(visited) >= 64 {
			return false
		}
		path, err := filepath.EvalSymlinks(path)
		if err != nil || !strings.HasPrefix(path, filepath.Join(root, "devices")+string(os.PathSeparator)) {
			return false
		}
		if visited[path] != 0 {
			return visited[path] == 2
		}
		visited[path] = 1
		defer func() { visited[path] = 2 }()
		if _, err := os.Stat(filepath.Join(path, "partition")); err == nil {
			return walk(filepath.Dir(path), depth+1)
		}
		if slaves, err := os.Open(filepath.Join(path, "slaves")); err == nil {
			names, readErr := slaves.Readdirnames(65)
			slaves.Close()
			if (readErr != nil && readErr != io.EOF) || len(names) > 64 {
				return false
			}
			if len(names) != 0 {
				for _, name := range names {
					if !walk(filepath.Join(path, "slaves", name), depth+1) {
						return false
					}
				}
				return true
			}
		} else if !os.IsNotExist(err) {
			return false
		}
		// A virtual leaf (loop, RAM disk or inaccessible device mapper) is not
		// evidence of a physical disk. Never derive a parent from its name.
		if strings.HasPrefix(path, filepath.Join(root, "devices", "virtual")+string(os.PathSeparator)) {
			return false
		}
		file, err := os.Open(filepath.Join(path, "size"))
		if err != nil {
			return false
		}
		value, err := io.ReadAll(io.LimitReader(file, 64))
		file.Close()
		sectors, parseErr := strconv.ParseUint(strings.TrimSpace(string(value)), 10, 64)
		if err != nil || parseErr != nil || sectors == 0 || sectors > ^uint64(0)/512 {
			return false
		}
		name := filepath.Base(path)
		if len(rows) >= maxBackingDisks {
			for _, row := range rows {
				if row.ID == name {
					return true
				}
			}
			return false
		}
		rows = appendPhysicalDisk(rows, PhysicalDisk{ID: name, Name: "/dev/" + name, Size: sectors * 512})
		return true
	}
	if !walk(start, 0) {
		return nil
	}
	return rows
}
