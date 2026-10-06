package agent

import (
	"errors"
	"runtime"
	"runtime/debug"
)

const (
	MiB                = 1 << 20
	MaxRSSBytes        = 32 * MiB
	RuntimeMemoryLimit = 20 * MiB
	MaxBinaryBytes     = 16 * MiB
	MaxConfigBytes     = 16 << 10
	MaxCABytes         = 256 << 10
	MaxRequestBytes    = 32 << 10
	MaxResponseBytes   = 8 << 10
	MaxInterfaces      = 16
	MaxMounts          = 8
)

var ErrMemoryBudget = errors.New("resident memory budget exceeded")

// ConfigureRuntime leaves room for executable pages, TLS and OS allocations.
// Go's limit is soft; use the generated service's cgroup limit for enforcement.
func ConfigureRuntime() {
	runtime.GOMAXPROCS(1)
	debug.SetMemoryLimit(RuntimeMemoryLimit)
	debug.SetGCPercent(80)
}

func CheckMemoryBudget() error {
	rss, err := ProcessRSS()
	if err == nil && rss >= MaxRSSBytes {
		return ErrMemoryBudget
	}
	return nil
}
