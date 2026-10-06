//go:build darwin

package agent

import "syscall"

func cpuTopology() cpuTopologyCounts {
	physical, _ := syscall.SysctlUint32("hw.physicalcpu")
	logical, _ := syscall.SysctlUint32("hw.logicalcpu")
	return checkedCPUTopology(int(physical), int(logical))
}
