//go:build darwin

package agent

import "testing"

func TestDarwinNativeCPUTopology(t *testing.T) {
	topology := cpuTopology()
	if topology.physical < 1 || topology.logical < topology.physical {
		t.Fatalf("invalid active system topology: physical=%d logical=%d", topology.physical, topology.logical)
	}
}
