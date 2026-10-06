//go:build linux

package agent

import (
	"bufio"
	"bytes"
	"errors"
	"os"
	"strconv"
	"strings"
)

func defaultMount() string { return "/" }

func kernelVersion() string {
	b, _ := ReadBounded("/proc/sys/kernel/osrelease", 512)
	return strings.TrimSpace(string(b))
}

func firstLine(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	line, err := bufio.NewReaderSize(f, 4096).ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return nil, err
	}
	return line, nil
}

func collectPlatform(c Config) rawMetrics {
	r := rawMetrics{disks: collectVolumes(c)}
	if b, err := firstLine("/proc/stat"); err == nil {
		r.cpu, _ = parseCPU(b)
	}
	if r.cpu == nil {
		r.unavailable = append(r.unavailable, "cpu")
	}
	if b, err := ReadBounded("/proc/meminfo", 32<<10); err == nil {
		r.memory, _ = parseMemory(b)
	}
	if r.memory == nil {
		r.unavailable = append(r.unavailable, "memory")
	}
	if b, err := firstLine("/proc/uptime"); err == nil {
		f := bytes.Fields(b)
		if len(f) > 0 {
			if v, e := strconv.ParseFloat(string(f[0]), 64); e == nil {
				r.uptime = &v
			}
		}
	}
	if r.uptime == nil {
		r.unavailable = append(r.unavailable, "uptime")
	}
	if b, err := ReadBounded("/proc/net/dev", 64<<10); err == nil {
		r.networks, _ = parseNetworks(b, c)
	}
	if r.networks == nil {
		r.unavailable = append(r.unavailable, "network")
	}
	return r
}

func ProcessRSS() (uint64, error) {
	b, err := firstLine("/proc/self/statm")
	if err != nil {
		return 0, err
	}
	f := bytes.Fields(b)
	if len(f) < 2 {
		return 0, errors.New("invalid RSS counters")
	}
	pages, err := strconv.ParseUint(string(f[1]), 10, 64)
	return pages * uint64(os.Getpagesize()), err
}
