package agent

import (
	"testing"
	"time"
)

func TestTopologyCacheReusesFailureAndRefreshes(t *testing.T) {
	var cache diskTopologyCache
	calls := 0
	read := func() []PhysicalDisk {
		calls++
		if calls == 1 {
			return nil
		}
		return []PhysicalDisk{{ID: "sda", Name: "/dev/sda"}}
	}
	if cache.get("8:1", read) != nil || cache.get("8:1", read) != nil || calls != 1 {
		t.Fatal("permission failure was repeatedly queried")
	}
	entry := cache.entries["8:1"]
	entry.until = time.Now().Add(-time.Second)
	cache.entries["8:1"] = entry
	if len(cache.get("8:1", read)) != 1 || calls != 2 {
		t.Fatal("topology did not refresh")
	}
}
