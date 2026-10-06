//go:build windows

package agent

import (
	"syscall"
	"unsafe"
)

func enableWorkingSetPrivilege() error {
	advapi := syscall.NewLazyDLL("advapi32.dll")
	var token syscall.Handle
	if ok, _, err := advapi.NewProc("OpenProcessToken").Call(^uintptr(0), 0x20|0x08, uintptr(unsafe.Pointer(&token))); ok == 0 {
		return err
	}
	defer syscall.CloseHandle(token)
	var privileges struct {
		Count      uint32
		Low        uint32
		High       int32
		Attributes uint32
	}
	name, _ := syscall.UTF16PtrFromString("SeIncreaseWorkingSetPrivilege")
	if ok, _, err := advapi.NewProc("LookupPrivilegeValueW").Call(0, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&privileges.Low))); ok == 0 {
		return err
	}
	privileges.Count, privileges.Attributes = 1, 2
	if ok, _, err := advapi.NewProc("AdjustTokenPrivileges").Call(uintptr(token), 0, uintptr(unsafe.Pointer(&privileges)), 0, 0, 0); ok == 0 || err == syscall.Errno(1300) {
		return err
	}
	return nil
}

func EnforceProcessLimit() error {
	var minimum, maximum uintptr
	var flags uint32
	if ok, _, err := kernel32.NewProc("GetProcessWorkingSetSizeEx").Call(^uintptr(0),
		uintptr(unsafe.Pointer(&minimum)), uintptr(unsafe.Pointer(&maximum)), uintptr(unsafe.Pointer(&flags))); ok == 0 {
		return err
	}
	// Do not raise the minimum working set: a low-privilege service should not
	// require an extra privilege just to impose a resident-memory ceiling.
	if minimum > MiB {
		minimum = MiB
	}
	setWorkingSet := kernel32.NewProc("SetProcessWorkingSetSizeEx")
	// No hard minimum reservation; hard maximum for resident physical pages.
	if ok, _, _ := setWorkingSet.Call(^uintptr(0), minimum, MaxRSSBytes, 0x02|0x04); ok != 0 {
		return nil
	}
	if err := enableWorkingSetPrivilege(); err != nil {
		return err
	}
	if ok, _, err := setWorkingSet.Call(^uintptr(0), minimum, MaxRSSBytes, 0x02|0x04); ok == 0 {
		return err
	}
	return nil
}
