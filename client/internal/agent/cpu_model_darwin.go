//go:build darwin

package agent

import "syscall"

func cpuModel() string {
	value, err := syscall.Sysctl("machdep.cpu.brand_string")
	if err != nil {
		return ""
	}
	return value
}
