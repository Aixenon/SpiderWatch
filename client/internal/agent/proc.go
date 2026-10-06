package agent

import (
	"bufio"
	"bytes"
	"errors"
	"strconv"
	"strings"
)

func parseCPU(line []byte) (*cpuCounters, error) {
	var result cpuCounters
	count := 0
	for field := range bytes.FieldsSeq(line) {
		if count == 0 {
			if string(field) != "cpu" {
				return nil, errors.New("invalid CPU counters")
			}
		} else {
			v, err := strconv.ParseUint(string(field), 10, 64)
			if err != nil {
				return nil, err
			}
			result.total += v
			switch count {
			case 1, 2:
				result.user += v
			case 3, 6, 7:
				result.system += v
			case 5:
				result.wait = v
				result.hasWait = true
			case 8:
				result.steal = v
				result.hasSteal = true
			}
			if count == 4 || count == 5 {
				result.idle += v
			}
		}
		count++
		if count == 9 {
			break
		}
	}
	if count < 5 {
		return nil, errors.New("invalid CPU counters")
	}
	result.detailed = true
	return &result, nil
}

// Only the first two fields matter; no per-line field slice is allocated.
func firstTwoFields(line []byte) (first, second []byte) {
	for field := range bytes.FieldsSeq(line) {
		if first == nil {
			first = field
		} else {
			return first, field
		}
	}
	return first, nil
}

func parseMemory(b []byte) (*MemoryMetrics, error) {
	const (
		total = iota
		available
		free
		buffers
		cached
		reclaimable
		shared
		swapTotal
		swapFree
		active
		inactive
		committed
		commitLimit
	)
	var values [13]uint64
	var seen [13]bool
	present := false
	s := bufio.NewScanner(bytes.NewReader(b))
	for s.Scan() {
		key, value := firstTwoFields(s.Bytes())
		if value == nil {
			continue
		}
		var index int
		switch string(bytes.TrimSuffix(key, []byte(":"))) {
		case "MemTotal":
			index = total
		case "MemAvailable":
			index = available
			present = true
		case "MemFree":
			index = free
		case "Buffers":
			index = buffers
		case "Cached":
			index = cached
		case "SReclaimable":
			index = reclaimable
		case "Shmem":
			index = shared
		case "SwapTotal":
			index = swapTotal
		case "SwapFree":
			index = swapFree
		case "Active":
			index = active
		case "Inactive":
			index = inactive
		case "Committed_AS":
			index = committed
		case "CommitLimit":
			index = commitLimit
		default:
			continue
		}
		v, err := strconv.ParseUint(string(value), 10, 64)
		if err != nil {
			return nil, err
		}
		values[index] = v * 1024
		seen[index] = true
	}
	if s.Err() != nil || values[total] == 0 {
		return nil, errors.New("invalid memory counters")
	}
	avail := values[available]
	if !present {
		avail = values[free] + values[buffers] + values[cached] + values[reclaimable]
		if values[shared] < avail {
			avail -= values[shared]
		} else {
			avail = 0
		}
	}
	if avail > values[total] {
		avail = values[total]
	}
	swapAvailable := values[swapFree]
	if swapAvailable > values[swapTotal] {
		swapAvailable = values[swapTotal]
	}
	optional := func(index int) *uint64 {
		if !seen[index] {
			return nil
		}
		return uintValue(values[index])
	}
	result := &MemoryMetrics{Free: optional(free), Cached: optional(cached), Buffers: optional(buffers),
		Active: optional(active), Inactive: optional(inactive), Committed: optional(committed), CommitLimit: optional(commitLimit), Total: values[total], Available: avail, Used: values[total] - avail,
		SwapTotal: values[swapTotal], SwapUsed: values[swapTotal] - swapAvailable, SwapSupported: true, Estimated: !present}
	// Cached includes reclaimable kernel caches, as in free(1).
	if result.Cached != nil {
		*result.Cached += values[reclaimable]
	}
	return result, nil
}

func parseNetworks(b []byte, c Config) ([]networkCounters, error) {
	result := make([]networkCounters, 0, MaxInterfaces)
	s := bufio.NewScanner(bytes.NewReader(b))
	for s.Scan() {
		line := s.Bytes()
		colon := bytes.LastIndexByte(line, ':')
		if colon < 0 {
			continue
		}
		name := strings.TrimSpace(string(line[:colon]))
		if !wantedInterface(c, name) {
			continue
		}
		if len(name) > 128 {
			return nil, errors.New("invalid network counters")
		}
		var rx, tx uint64
		count := 0
		for field := range bytes.FieldsSeq(line[colon+1:]) {
			if count == 0 || count == 8 {
				value, err := strconv.ParseUint(string(field), 10, 64)
				if err != nil {
					return nil, errors.New("invalid network counters")
				}
				if count == 0 {
					rx = value
				} else {
					tx = value
				}
			}
			count++
			if count == 16 {
				break
			}
		}
		if count < 16 {
			return nil, errors.New("invalid network counters")
		}
		if len(result) >= MaxInterfaces {
			break
		}
		result = append(result, networkCounters{name: name, rx: rx, tx: tx})
	}
	return result, s.Err()
}
