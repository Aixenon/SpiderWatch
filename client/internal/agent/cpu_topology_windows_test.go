//go:build windows

package agent

import (
	"runtime"
	"testing"
)

func TestWindowsNativeCPUTopology(t *testing.T) {
	topology := cpuTopology()
	if topology.physical < 1 || topology.logical < topology.physical || topology.logical < runtime.NumCPU() {
		t.Fatalf("invalid active system topology: physical=%d logical=%d process_available=%d", topology.physical, topology.logical, runtime.NumCPU())
	}
	t.Logf("physical=%d logical=%d process_available=%d", topology.physical, topology.logical, runtime.NumCPU())
}
