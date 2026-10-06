//go:build linux

package agent

import "os"

func cpuTopology() cpuTopologyCounts {
	if topology := readSysfsCPUTopology(os.DirFS("/sys/devices/system/cpu")); topology.logical != 0 {
		return topology
	}
	file, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return cpuTopologyCounts{}
	}
	defer file.Close()
	return readProcCPUTopology(file)
}
