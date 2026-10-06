package agent

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
)

func sysfsCPUFixture(online string, rows ...[5]int) fstest.MapFS {
	files := fstest.MapFS{"online": {Data: []byte(online)}}
	for _, row := range rows {
		for i, key := range []string{"physical_package_id", "core_id", "die_id", "cluster_id"} {
			files[fmt.Sprintf("cpu%d/topology/%s", row[0], key)] = &fstest.MapFile{Data: []byte(fmt.Sprint(row[i+1]))}
		}
	}
	return files
}

func TestSysfsCPUTopologyCountsActiveCoresAcrossSocketsAndDies(t *testing.T) {
	tests := []struct {
		name  string
		files fstest.MapFS
		want  cpuTopologyCounts
	}{
		{"SMT and repeated core IDs across sockets", sysfsCPUFixture("0-7", [5]int{0, 0, 0, -1, -1}, [5]int{1, 0, 0, -1, -1}, [5]int{2, 0, 1, -1, -1}, [5]int{3, 0, 1, -1, -1}, [5]int{4, 1, 0, -1, -1}, [5]int{5, 1, 0, -1, -1}, [5]int{6, 1, 1, -1, -1}, [5]int{7, 1, 1, -1, -1}), cpuTopologyCounts{4, 8}},
		{"same core IDs in different dies", sysfsCPUFixture("0-3", [5]int{0, 0, 0, 0, -1}, [5]int{1, 0, 0, 0, -1}, [5]int{2, 0, 0, 1, -1}, [5]int{3, 0, 0, 1, -1}), cpuTopologyCounts{2, 4}},
		{"same core IDs in different clusters", sysfsCPUFixture("1,3", [5]int{1, 0, 0, -1, 0}, [5]int{3, 0, 0, -1, 1}), cpuTopologyCounts{2, 2}},
		{"offline CPU zero and offline SMT siblings", sysfsCPUFixture("1,3,6", [5]int{0, 0, 0, -1, -1}, [5]int{1, 0, 0, -1, -1}, [5]int{2, 0, 1, -1, -1}, [5]int{3, 0, 1, -1, -1}, [5]int{4, 0, 2, -1, -1}, [5]int{6, 0, 3, -1, -1}), cpuTopologyCounts{3, 3}},
		{"kernel default unknown topology", sysfsCPUFixture("0-1", [5]int{0, -1, 0, -1, -1}, [5]int{1, -1, 0, -1, -1}), cpuTopologyCounts{0, 2}},
		{"missing active topology", sysfsCPUFixture("0-1", [5]int{0, 0, 0, -1, -1}), cpuTopologyCounts{0, 2}},
		{"invalid online list", sysfsCPUFixture("0-1,1"), cpuTopologyCounts{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := readSysfsCPUTopology(test.files); got != test.want {
				t.Fatalf("topology=%+v, want %+v", got, test.want)
			}
		})
	}
}

func TestSysfsCPUTopologyAcceptsAbsentOptionalHierarchyButNotPartialCores(t *testing.T) {
	files := sysfsCPUFixture("0-1", [5]int{0, 0, 0, 0, 0}, [5]int{1, 0, 1, 0, 0})
	for id := range 2 {
		delete(files, fmt.Sprintf("cpu%d/topology/die_id", id))
		delete(files, fmt.Sprintf("cpu%d/topology/cluster_id", id))
	}
	if got := readSysfsCPUTopology(files); got != (cpuTopologyCounts{2, 2}) {
		t.Fatalf("older kernel optional fields: %+v", got)
	}
	delete(files, "cpu1/topology/core_id")
	if got := readSysfsCPUTopology(files); got != (cpuTopologyCounts{0, 2}) {
		t.Fatalf("partial topology reported a physical count: %+v", got)
	}
}

type changingCPUOnlineFS struct {
	fs.FS
	onlineReads int
}

func (files *changingCPUOnlineFS) Open(name string) (fs.File, error) {
	if name == "online" {
		files.onlineReads++
		if files.onlineReads > 1 {
			return fstest.MapFS{"online": {Data: []byte("0-1")}}.Open(name)
		}
	}
	return files.FS.Open(name)
}

func TestSysfsCPUHotplugDoesNotMixTopologySnapshots(t *testing.T) {
	files := &changingCPUOnlineFS{FS: sysfsCPUFixture("0", [5]int{0, 0, 0, -1, -1})}
	if got := readSysfsCPUTopology(files); got != (cpuTopologyCounts{0, 2}) {
		t.Fatalf("mixed two active CPU sets: %+v", got)
	}
}

func TestOnlineCPUListBoundsAndSparseIDs(t *testing.T) {
	ids, ok := parseOnlineCPUs("1,3-4,8\n")
	if !ok || fmt.Sprint(ids) != "[1 3 4 8]" {
		t.Fatalf("sparse online list: %v, %v", ids, ok)
	}
	for _, text := range []string{"", "-1", "+1", "1-0", "0,0", "2,1", "0-2,2-3", "0-65536", "65536", "0,", "0-x", strings.Repeat("0", maxCPUListBytes+1)} {
		if _, ok := parseOnlineCPUs(text); ok {
			t.Fatalf("accepted invalid CPU list %.40q", text)
		}
	}
}

func TestProcCPUTopologyRequiresCompletePhysicalRecords(t *testing.T) {
	tests := []struct {
		name, text string
		want       cpuTopologyCounts
	}{
		{"two sockets SMT and final record without newline", "processor:0\nphysical id:0\ncore id:0\n\nprocessor:1\nphysical id:0\ncore id:0\n\nprocessor:4\nphysical id:1\ncore id:0", cpuTopologyCounts{2, 3}},
		{"ARM without physical topology", "processor:0\nmodel name:ARM\n\nprocessor:1\nmodel name:ARM\nHardware:board\n", cpuTopologyCounts{0, 2}},
		{"partially available physical topology", "processor:0\nphysical id:0\ncore id:0\n\nprocessor:1\nphysical id:0", cpuTopologyCounts{0, 2}},
		{"negative package is unknown", "processor:0\nphysical id:-1\ncore id:0", cpuTopologyCounts{0, 1}},
		{"duplicate processor invalidates count", "processor:0\nphysical id:0\ncore id:0\n\nprocessor:0\nphysical id:1\ncore id:0", cpuTopologyCounts{}},
		{"malformed processor invalidates count", "processor:0\nphysical id:0\ncore id:0\n\nprocessor:x", cpuTopologyCounts{}},
		{"physical core summary is not topology", "processor:0\ncpu cores:8\nsiblings:16", cpuTopologyCounts{0, 1}},
		{"contradictory core ID is unknown", "processor:0\nphysical id:0\ncore id:0\ncore id:1", cpuTopologyCounts{0, 1}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := readProcCPUTopology(strings.NewReader(test.text)); got != test.want {
				t.Fatalf("topology=%+v, want %+v", got, test.want)
			}
		})
	}
}

type failedTopologyReader struct{}

func (failedTopologyReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }

func TestProcCPUTopologyRejectsReadFailuresAndOversizedInput(t *testing.T) {
	valid := "processor:0\nphysical id:0\ncore id:0\n"
	for _, reader := range []io.Reader{
		io.MultiReader(strings.NewReader(valid), failedTopologyReader{}),
		strings.NewReader(valid + strings.Repeat("unused: padding\n", maxCPUTopologyBytes/8)),
		strings.NewReader(valid + strings.Repeat("x", maxCPUListBytes+1)),
	} {
		if got := readProcCPUTopology(reader); got != (cpuTopologyCounts{}) {
			t.Fatalf("partial/oversized source was reported as complete: %+v", got)
		}
	}
}

func windowsCoreFixture(pointerBytes, groups int) []byte {
	data := make([]byte, 32+groups*(pointerBytes+8))
	binary.LittleEndian.PutUint32(data[4:], uint32(len(data)))
	binary.LittleEndian.PutUint16(data[30:], uint16(groups))
	for group := range groups {
		// Repeated masks intentionally model folded WOW64 masks; only the
		// number of processor-core records establishes the physical count.
		data[32+group*(pointerBytes+8)] = 3
	}
	return data
}

func TestWindowsCPURecordsDoNotCountAffinityMaskBits(t *testing.T) {
	for _, pointerBytes := range []int{4, 8} {
		data := append(windowsCoreFixture(pointerBytes, 1), windowsCoreFixture(pointerBytes, 2)...)
		if count := windowsPhysicalCoreCount(data, pointerBytes); count != 2 {
			t.Fatalf("%d-bit physical cores=%d", pointerBytes*8, count)
		}
		for _, bad := range [][]byte{data[:len(data)-1], append(append([]byte{}, data...), 0), data[:7]} {
			if windowsPhysicalCoreCount(bad, pointerBytes) != 0 {
				t.Fatal("accepted incomplete Windows topology")
			}
		}
		bad := windowsCoreFixture(pointerBytes, 1)
		binary.LittleEndian.PutUint32(bad, 3) // A socket is not a core.
		if windowsPhysicalCoreCount(bad, pointerBytes) != 0 {
			t.Fatal("counted packages as physical cores")
		}
	}
}

func TestCPUCountFieldsPreserveLegacyAffinitySemantics(t *testing.T) {
	host := HostInfo{CPUs: 2, PhysicalCPUs: 4, LogicalCPUs: 8}
	encoded, err := json.Marshal(host)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["cpus"] != float64(2) || fields["physical_cpus"] != float64(4) || fields["logical_cpus"] != float64(8) {
		t.Fatalf("CPU count scopes changed: %s", encoded)
	}
	encoded, _ = json.Marshal(HostInfo{CPUs: 2})
	if strings.Contains(string(encoded), "physical_cpus") || strings.Contains(string(encoded), "logical_cpus") {
		t.Fatal("unknown topology must be omitted, never copied from runtime.NumCPU")
	}
	if got := checkedCPUTopology(0, 8); got.physical != 0 || got.logical != 8 {
		t.Fatalf("invented physical topology: %+v", got)
	}
}
