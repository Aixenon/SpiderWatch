//go:build darwin

package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestAPFSPhysicalStoresUseActualParentMap(t *testing.T) {
	physical, err := decodeDiskPlist(strings.NewReader(`<plist><dict><key>AllDisksAndPartitions</key><array>
<dict><key>DeviceIdentifier</key><string>disk0</string><key>Size</key><integer>1000</integer><key>Partitions</key><array><dict><key>DeviceIdentifier</key><string>disk0s2</string></dict></array></dict>
<dict><key>DeviceIdentifier</key><string>disk4</string><key>Size</key><integer>2000</integer><key>Partitions</key><array><dict><key>DeviceIdentifier</key><string>disk4s8</string></dict></array></dict>
</array></dict></plist>`))
	if err != nil {
		t.Fatal(err)
	}
	rows := physicalDiskPlist(physical)
	apfs, err := decodeDiskPlist(strings.NewReader(`<plist><dict><key>Containers</key><array><dict><key>ContainerReference</key><string>disk9</string><key>PhysicalStores</key><array><dict><key>DeviceIdentifier</key><string>disk0s2</string></dict><dict><key>DeviceIdentifier</key><string>disk4s8</string></dict></array><key>Volumes</key><array><dict><key>DeviceIdentifier</key><string>disk9s1</string></dict></array></dict></array></dict></plist>`))
	if err != nil {
		t.Fatal(err)
	}
	addAPFSPhysicalDisks(rows, apfs)
	if len(rows["disk9s1"]) != 2 || rows["disk9s1"][0].ID != "disk0" || rows["disk9s1"][1].ID != "disk4" {
		t.Fatalf("APFS mapping: %+v", rows)
	}
	if rows["disk9s1"][0].Size != 1000 || rows["disk9s1"][1].Size != 2000 {
		t.Fatal("container size confused with physical capacity")
	}
	delete(rows, "disk4s8")
	delete(rows, "disk9s1")
	addAPFSPhysicalDisks(rows, apfs)
	if rows["disk9s1"] != nil {
		t.Fatal("incomplete Fusion topology reported as complete")
	}
}

func TestAPFSContainerCapacityIsSharedAndDistinctFromVolumeUsage(t *testing.T) {
	data, err := decodeDiskPlist(strings.NewReader(`<plist><dict><key>Containers</key><array><dict>
<key>ContainerReference</key><string>disk9</string><key>CapacityCeiling</key><integer>1000</integer><key>CapacityFree</key><integer>300</integer>
<key>Volumes</key><array><dict><key>DeviceIdentifier</key><string>disk9s1</string></dict><dict><key>DeviceIdentifier</key><string>disk9s2</string></dict></array>
</dict></array></dict></plist>`))
	if err != nil {
		t.Fatal(err)
	}
	// Capacity does not depend on being allowed to resolve physical stores.
	rows := apfsPoolPlist(data)
	if rows["disk9"] == nil || rows["disk9"] != rows["disk9s1"] || rows["disk9s1"] != rows["disk9s2"] {
		t.Fatal("volumes do not share their actual container")
	}
	first, second := DiskMetrics{Used: 200, Total: 1000}, DiskMetrics{Used: 400, Total: 1000}
	applyAPFSPool(&first, rows["disk9s1"])
	applyAPFSPool(&second, rows["disk9s2"])
	if first.CapacityGroup != "apfs:disk9" || *first.PoolTotal != 1000 || *first.PoolAvailable != 300 || *first.PoolTotal-*first.PoolAvailable != 700 || first.Used != 200 || second.Used != 400 {
		t.Fatal("pool capacity confused with per-volume used blocks")
	}
	if first.PoolAvailable != second.PoolAvailable {
		t.Fatal("shared metadata unnecessarily copied")
	}
}

func TestAPFSPoolCapacityZeroAndMissingValues(t *testing.T) {
	for _, test := range []struct {
		total, free string
		known       bool
	}{
		{"1000", "0", true}, {"1000", "300", true}, {"1000", "", false}, {"", "300", false}, {"0", "0", false}, {"1000", "1001", false}, {"1000", "-1", false}, {"18446744073709551616", "0", false},
	} {
		t.Run(test.total+"/"+test.free, func(t *testing.T) {
			data, err := decodeDiskPlist(strings.NewReader(fmt.Sprintf(`<dict><key>Containers</key><array><dict><key>ContainerReference</key><string>disk2</string><key>CapacityCeiling</key><integer>%s</integer><key>CapacityFree</key><integer>%s</integer></dict></array></dict>`, test.total, test.free)))
			if err != nil {
				t.Fatal(err)
			}
			pool := apfsPoolPlist(data)["disk2"]
			if pool == nil || pool.Known != test.known {
				t.Fatalf("capacity validation: %+v", pool)
			}
			var volume DiskMetrics
			applyAPFSPool(&volume, pool)
			if (volume.PoolTotal != nil) != test.known || (volume.PoolAvailable != nil) != test.known {
				t.Fatal("unknown capacity serialized as known zero")
			}
			encoded, _ := json.Marshal(volume)
			if test.known && test.free == "0" && !strings.Contains(string(encoded), `"pool_available_bytes":0`) {
				t.Fatal("known full pool lost its zero free value")
			}
		})
	}
	var volume DiskMetrics
	applyAPFSPool(&volume, nil)
	if volume.PoolTotal != nil || volume.PoolAvailable != nil {
		t.Fatal("missing pool metadata invented")
	}
}

func TestDiskPlistLimitsAndMalformedInput(t *testing.T) {
	for _, text := range []string{`<plist><dict><key>x</key><array>`, `<dict><string>missing key</string></dict>`, `<dict><key>x</key>` + strings.Repeat("<array>", 20) + strings.Repeat("</array>", 20) + `</dict>`} {
		if _, err := decodeDiskPlist(strings.NewReader(text)); err == nil {
			t.Fatal("accepted invalid or unbounded plist")
		}
	}
}
