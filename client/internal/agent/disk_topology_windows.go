//go:build windows

package agent

import (
	"encoding/binary"
	"strconv"
	"strings"
	"syscall"
)

var windowsDiskTopology diskTopologyCache

func windowsBackingDisks(volume string) []PhysicalDisk {
	return windowsDiskTopology.get(volume, func() []PhysicalDisk {
		handle, err := openDiskMetadata(strings.TrimSuffix(volume, `\`))
		if err != nil {
			return nil
		}
		defer syscall.CloseHandle(handle)
		// LARGE_INTEGER members use the Windows SDK's eight-byte alignment on
		// both Win32 and Win64. Decode bytes rather than Go struct alignment.
		var data [8 + 64*24]byte
		var returned uint32
		const getVolumeDiskExtents = 0x560000 // FILE_ANY_ACCESS
		if syscall.DeviceIoControl(handle, getVolumeDiskExtents, nil, 0, &data[0], uint32(len(data)), &returned, nil) != nil || returned > uint32(len(data)) {
			return nil
		}
		numbers := volumeDiskNumbers(data[:returned])
		var disks []PhysicalDisk
		for _, number := range numbers {
			id := "PhysicalDrive" + strconv.FormatUint(uint64(number), 10)
			disks = appendPhysicalDisk(disks, PhysicalDisk{ID: id, Name: id, Size: windowsDiskSize(id)})
		}
		return disks
	})
}

func openDiskMetadata(path string) (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return syscall.InvalidHandle, err
	}
	// Zero desired access obtains metadata only. Failure under a service's
	// existing permissions leaves the mapping unknown; never elevate access.
	return syscall.CreateFile(name, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, 0, 0)
}

func volumeDiskNumbers(data []byte) []uint32 {
	if len(data) < 8 {
		return nil
	}
	count := uint64(binary.LittleEndian.Uint32(data))
	if count == 0 || count > 64 || count*24+8 > uint64(len(data)) {
		return nil
	}
	var numbers []uint32
	for i := uint64(0); i < count; i++ {
		number := binary.LittleEndian.Uint32(data[8+i*24:])
		found := false
		for _, existing := range numbers {
			if existing == number {
				found = true
				break
			}
		}
		if !found {
			if len(numbers) == maxBackingDisks {
				return nil
			}
			numbers = append(numbers, number)
		}
	}
	return numbers
}

func windowsDiskSize(id string) uint64 {
	handle, err := openDiskMetadata(`\\.\` + id)
	if err != nil {
		return 0
	}
	defer syscall.CloseHandle(handle)
	var data [1024]byte
	var returned uint32
	const getDriveGeometryEx = 0x700a0 // FILE_ANY_ACCESS
	if syscall.DeviceIoControl(handle, getDriveGeometryEx, nil, 0, &data[0], uint32(len(data)), &returned, nil) != nil || returned < 32 {
		return 0
	}
	return binary.LittleEndian.Uint64(data[24:32])
}
