//go:build windows

package agent

import "os"

func StopSignals() []os.Signal { return []os.Signal{os.Interrupt} }
