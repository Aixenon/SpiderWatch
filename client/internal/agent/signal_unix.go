//go:build !windows

package agent

import (
	"os"
	"syscall"
)

func StopSignals() []os.Signal { return []os.Signal{os.Interrupt, syscall.SIGTERM} }
