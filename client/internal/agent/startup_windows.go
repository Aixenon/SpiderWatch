//go:build windows

package agent

import (
	"errors"
	"unsafe"
)

func AvailableMemory() (uint64, error) {
	var memory memoryStatus
	memory.Length = uint32(unsafe.Sizeof(memory))
	if ok, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&memory))); ok == 0 {
		return 0, errors.New("GlobalMemoryStatusEx failed")
	}
	return memory.AvailPhys, nil
}
