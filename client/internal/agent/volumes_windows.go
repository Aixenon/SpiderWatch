//go:build windows

package agent

import (
	"encoding/binary"
	"strings"
	"syscall"
	"unsafe"
)

var (
	findFirstVolume        = kernel32.NewProc("FindFirstVolumeW")
	findNextVolume         = kernel32.NewProc("FindNextVolumeW")
	findVolumeClose        = kernel32.NewProc("FindVolumeClose")
	volumePaths            = kernel32.NewProc("GetVolumePathNamesForVolumeNameW")
	volumeInformation      = kernel32.NewProc("GetVolumeInformationW")
	processorInformation   = kernel32.NewProc("GetLogicalProcessorInformationEx")
	performanceInformation = kernel32.NewProc("K32GetPerformanceInfo")
)

func collectVolumes(c Config) []DiskMetrics {
	rows := make([]DiskMetrics, 0, 4)
	var name [128]uint16
	handle, _, _ := findFirstVolume.Call(uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
	if handle == ^uintptr(0) {
		return configuredWindowsVolumes(c)
	}
	defer findVolumeClose.Call(handle)
	for count := 0; count < 1024; count++ {
		var available, total, free uint64
		if ok, _, _ := getDiskFreeSpaceEx.Call(uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&available)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free))); ok != 0 && total > 0 {
			var paths [1024]uint16
			var required uint32
			mount := ""
			if ok, _, _ := volumePaths.Call(uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&paths[0])), uintptr(len(paths)), uintptr(unsafe.Pointer(&required))); ok != 0 {
				mount = syscall.UTF16ToString(paths[:])
			}
			var label [128]uint16
			var filesystem [32]uint16
			volumeInformation.Call(uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&label[0])), uintptr(len(label)), 0, 0, 0, uintptr(unsafe.Pointer(&filesystem[0])), uintptr(len(filesystem)))
			id := syscall.UTF16ToString(name[:])
			device := strings.TrimSuffix(mount, `\`)
			if len(mount) != 3 || mount[1] != ':' || mount[2] != '\\' {
				device = strings.TrimSuffix(strings.TrimPrefix(id, `\\?\`), `\`)
			}
			rows = appendVolume(rows, DiskMetrics{VolumeID: id, Device: device, Label: syscall.UTF16ToString(label[:]), Filesystem: syscall.UTF16ToString(filesystem[:]), Mount: mount, Total: total, Available: available, Used: total - free, PhysicalDisks: windowsBackingDisks(id)})
		}
		if ok, _, _ := findNextVolume.Call(handle, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name))); ok == 0 {
			break
		}
	}
	return rows
}
func configuredWindowsVolumes(c Config) []DiskMetrics {
	rows := make([]DiskMetrics, 0, len(c.Mounts))
	for _, mount := range c.Mounts {
		path, err := syscall.UTF16PtrFromString(mount)
		if err != nil {
			continue
		}
		var available, total, free uint64
		if ok, _, _ := getDiskFreeSpaceEx.Call(uintptr(unsafe.Pointer(path)), uintptr(unsafe.Pointer(&available)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free))); ok != 0 {
			rows = appendVolume(rows, DiskMetrics{VolumeID: strings.ToLower(mount), Device: strings.TrimSuffix(mount, `\`), Mount: mount, Total: total, Available: available, Used: total - free})
		}
	}
	return rows
}
func physicalCPUs() int {
	var size uint32
	processorInformation.Call(0, 0, uintptr(unsafe.Pointer(&size)))
	if size < 8 || size > 1<<20 {
		return 0
	}
	data := make([]byte, size)
	if ok, _, _ := processorInformation.Call(0, uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(&size))); ok == 0 {
		return 0
	}
	count := 0
	for offset := uint32(0); offset+8 <= size; {
		relationship := binary.LittleEndian.Uint32(data[offset:])
		length := binary.LittleEndian.Uint32(data[offset+4:])
		if length < 8 || length > size-offset {
			return 0
		}
		if relationship == 0 {
			count++
		}
		offset += length
	}
	return count
}

type performanceInfo struct {
	Size                                                                                                                                    uint32
	CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable, SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize uintptr
	Handles, Processes, Threads                                                                                                             uint32
}

func memoryDetails(m *MemoryMetrics) {
	var p performanceInfo
	p.Size = uint32(unsafe.Sizeof(p))
	if ok, _, _ := performanceInformation.Call(uintptr(unsafe.Pointer(&p)), uintptr(p.Size)); ok != 0 {
		m.Cached = uintValue(uint64(p.SystemCache) * uint64(p.PageSize))
		m.Committed = uintValue(uint64(p.CommitTotal) * uint64(p.PageSize))
		m.CommitLimit = uintValue(uint64(p.CommitLimit) * uint64(p.PageSize))
	}
}
