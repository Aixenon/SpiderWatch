//go:build linux

package agent

import "os"

func cpuModel() string {
	file, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return ""
	}
	defer file.Close()
	return parseCPUModel(file)
}
