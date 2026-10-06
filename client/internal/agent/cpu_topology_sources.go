package agent

import (
	"bufio"
	"errors"
	"io"
	"io/fs"
	"strconv"
	"strings"
)

const maxCPUListBytes = 64 << 10

func topologyFile(files fs.FS, name string, limit int64) (string, error) {
	file, err := files.Open(name)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return "", fs.ErrInvalid
	}
	return strings.TrimSpace(string(data)), nil
}

func topologyID(text string) (int64, bool) {
	if text == "" {
		return 0, false
	}
	for _, char := range text {
		if char < '0' || char > '9' {
			return 0, false
		}
	}
	value, err := strconv.ParseInt(text, 10, 32)
	return value, err == nil && value >= 0
}

// Kernel CPU lists are ordered, non-overlapping IDs/ranges. Neither sparse IDs
// nor an offline CPU 0 can be counted using the highest processor ID.
func parseOnlineCPUs(text string) ([]int, bool) {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > maxCPUListBytes {
		return nil, false
	}
	ids := make([]int, 0, 8)
	last := -1
	for _, part := range strings.Split(text, ",") {
		start, end, ranged := strings.Cut(strings.TrimSpace(part), "-")
		first, ok := topologyID(start)
		if !ok || first >= maxCPUCount || first <= int64(last) {
			return nil, false
		}
		final := first
		if ranged {
			var valid bool
			final, valid = topologyID(end)
			if !valid || final < first || final >= maxCPUCount {
				return nil, false
			}
		}
		for id := int(first); id <= int(final); id++ {
			ids = append(ids, id)
		}
		last = int(final)
	}
	return ids, true
}

type sysfsCoreID struct{ socket, die, cluster, core int64 }

func readSysfsCPUTopology(files fs.FS) cpuTopologyCounts {
	online, err := topologyFile(files, "online", maxCPUListBytes)
	ids, valid := parseOnlineCPUs(online)
	if err != nil || !valid {
		return cpuTopologyCounts{}
	}
	result := cpuTopologyCounts{logical: len(ids)}
	cores := make(map[sysfsCoreID]struct{}, len(ids))
	for _, id := range ids {
		base := "cpu" + strconv.Itoa(id) + "/topology/"
		readID := func(name string, optional bool) (int64, bool) {
			text, err := topologyFile(files, base+name, 32)
			if optional && (errors.Is(err, fs.ErrNotExist) || err == nil && text == "-1") {
				return -1, true
			}
			value, ok := topologyID(text)
			return value, err == nil && ok
		}
		socket, socketOK := readID("physical_package_id", false)
		core, coreOK := readID("core_id", false)
		die, dieOK := readID("die_id", true)
		cluster, clusterOK := readID("cluster_id", true)
		// Generic kernel defaults (-1 package, 0 core) do not establish physical
		// topology, especially on ARM/MIPS/RISC-V. Do not report a partial count.
		if !socketOK || !coreOK || !dieOK || !clusterOK {
			return result
		}
		cores[sysfsCoreID{socket, die, cluster, core}] = struct{}{}
	}
	result.physical = len(cores)
	// Hotplug may change which topology files exist during collection. Keep a
	// current logical count but omit physical data collected across two states.
	if after, err := topologyFile(files, "online", maxCPUListBytes); err != nil || after != online {
		result.physical = 0
		if latest, ok := parseOnlineCPUs(after); err == nil && ok {
			result.logical = len(latest)
		}
	}
	return checkedCPUTopology(result.physical, result.logical)
}

// Used only when sysfs cannot provide an online CPU list. Every processor must
// have a unique numeric ID; physical counting additionally requires topology
// on every record. "cpu cores", "siblings", or processor count are not substitutes.
func readProcCPUTopology(reader io.Reader) cpuTopologyCounts {
	limited := &io.LimitedReader{R: reader, N: maxCPUTopologyBytes + 1}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 1024), maxCPUListBytes)
	processors := make(map[int64]struct{})
	cores := make(map[[2]int64]struct{})
	id, socket, core := int64(-1), int64(-1), int64(-1)
	complete := true
	add := func() bool {
		if id < 0 {
			socket, core = -1, -1
			return true
		}
		if _, duplicate := processors[id]; duplicate || len(processors) == maxCPUCount {
			return false
		}
		processors[id] = struct{}{}
		if socket < 0 || core < 0 {
			complete = false
		} else {
			cores[[2]int64{socket, core}] = struct{}{}
		}
		id, socket, core = -1, -1, -1
		return true
	}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			if !add() {
				return cpuTopologyCounts{}
			}
			continue
		}
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		switch key {
		case "processor":
			if !add() {
				return cpuTopologyCounts{}
			}
			parsed, ok := topologyID(value)
			if !ok || parsed >= maxCPUCount {
				return cpuTopologyCounts{}
			}
			id = parsed
		case "physical id", "core id":
			parsed, ok := topologyID(value)
			if !ok {
				complete = false
				parsed = -1
			}
			if key == "physical id" {
				if socket >= 0 && socket != parsed {
					complete = false
				}
				socket = parsed
			} else {
				if core >= 0 && core != parsed {
					complete = false
				}
				core = parsed
			}
		}
	}
	if scanner.Err() != nil || limited.N == 0 || !add() {
		return cpuTopologyCounts{}
	}
	physical := 0
	if complete {
		physical = len(cores)
	}
	return checkedCPUTopology(physical, len(processors))
}
