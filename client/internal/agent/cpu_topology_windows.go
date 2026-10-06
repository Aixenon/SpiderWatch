//go:build windows

package agent

import "unsafe"

var (
	processorInformation = kernel32.NewProc("GetLogicalProcessorInformationEx")
	activeProcessorCount = kernel32.NewProc("GetActiveProcessorCount")
)

func cpuTopology() cpuTopologyCounts {
	logical := 0
	if activeProcessorCount.Find() == nil {
		value, _, _ := activeProcessorCount.Call(0xffff) // ALL_PROCESSOR_GROUPS.
		if value <= maxCPUCount {
			logical = int(value)
		}
	}
	physical := 0
	if processorInformation.Find() == nil {
		var size uint32
		processorInformation.Call(0, 0, uintptr(unsafe.Pointer(&size)))
		if size >= 32 && size <= maxCPUTopologyBytes {
			data := make([]byte, size)
			if ok, _, _ := processorInformation.Call(0, uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(&size))); ok != 0 && size <= uint32(len(data)) {
				physical = windowsPhysicalCoreCount(data[:size], int(unsafe.Sizeof(uintptr(0))))
			}
		}
	}
	return checkedCPUTopology(physical, logical)
}
