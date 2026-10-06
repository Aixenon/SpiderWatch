//go:build windows

package agent

import (
	"syscall"
	"unsafe"
)

func cpuModel() string {
	path, _ := syscall.UTF16PtrFromString(`HARDWARE\DESCRIPTION\System\CentralProcessor\0`)
	var key syscall.Handle
	if syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, path, 0, syscall.KEY_QUERY_VALUE, &key) != nil {
		return ""
	}
	defer syscall.RegCloseKey(key)
	name, _ := syscall.UTF16PtrFromString("ProcessorNameString")
	var data [256]uint16
	size, kind := uint32(len(data)*2), uint32(0)
	if syscall.RegQueryValueEx(key, name, nil, &kind, (*byte)(unsafe.Pointer(&data[0])), &size) != nil || kind != syscall.REG_SZ || size > uint32(len(data)*2) || size%2 != 0 {
		return ""
	}
	return syscall.UTF16ToString(data[:size/2])
}
