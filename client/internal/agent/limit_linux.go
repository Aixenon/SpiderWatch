//go:build linux

package agent

import "syscall"

func EnforceProcessLimit() error {
	// RSS enforcement is provided by the service's cgroup. Core dumps would
	// violate the disk budget and could contain authentication credentials.
	return syscall.Setrlimit(syscall.RLIMIT_CORE, &syscall.Rlimit{Cur: 0, Max: 0})
}
