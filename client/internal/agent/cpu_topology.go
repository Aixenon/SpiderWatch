package agent

import "encoding/binary"

const maxCPUCount = 65536
const maxCPUTopologyBytes = 1 << 20

// These are OS-visible active system counts at collector initialization,
// including guest topology in a VM.
// They do not describe the VM host or a process's affinity/cgroup CPU quota.
// HostInfo.CPUs deliberately retains its older runtime.NumCPU semantics.
type cpuTopologyCounts struct{ physical, logical int }

func checkedCPUTopology(physical, logical int) cpuTopologyCounts {
	if logical < 1 || logical > maxCPUCount {
		logical = 0
	}
	if physical < 1 || physical > maxCPUCount || logical > 0 && physical > logical {
		physical = 0
	}
	return cpuTopologyCounts{physical: physical, logical: logical}
}

// Count records, not affinity-mask bits: WOW64 can fold the upper 32 mask bits
// onto the lower ones. Microsoft guarantees one RelationProcessorCore record
// per active physical core across all processor groups, even for 32-bit callers.
func windowsPhysicalCoreCount(data []byte, pointerBytes int) int {
	if len(data) == 0 || len(data) > maxCPUTopologyBytes || (pointerBytes != 4 && pointerBytes != 8) {
		return 0
	}
	count := 0
	for len(data) != 0 {
		if len(data) < 32 || binary.LittleEndian.Uint32(data) != 0 {
			return 0
		}
		length := int(binary.LittleEndian.Uint32(data[4:]))
		groups := int(binary.LittleEndian.Uint16(data[30:]))
		if groups == 0 || length < 32+groups*(pointerBytes+8) || length > len(data) {
			return 0
		}
		count++
		if count > maxCPUCount {
			return 0
		}
		data = data[length:]
	}
	return count
}
