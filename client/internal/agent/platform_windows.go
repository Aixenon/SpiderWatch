//go:build windows

package agent

import (
	"errors"
	"net"
	"os"
	"syscall"
	"unsafe"
)

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	iphlpapi             = syscall.NewLazyDLL("iphlpapi.dll")
	getSystemTimes       = kernel32.NewProc("GetSystemTimes")
	globalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	getDiskFreeSpaceEx   = kernel32.NewProc("GetDiskFreeSpaceExW")
	getTickCount64       = kernel32.NewProc("GetTickCount64")
	getProcessMemoryInfo = kernel32.NewProc("K32GetProcessMemoryInfo")
	getIfEntry2          = iphlpapi.NewProc("GetIfEntry2")
	moveFileEx           = kernel32.NewProc("MoveFileExW")
	lockFileEx           = kernel32.NewProc("LockFileEx")
	unlockFileEx         = kernel32.NewProc("UnlockFileEx")
)

func defaultMount() string {
	drive := os.Getenv("SystemDrive")
	if drive == "" {
		drive = "C:"
	}
	return drive + `\`
}

func kernelVersion() string { return "" }

type memoryStatus struct {
	Length, Load                                       uint32
	TotalPhys, AvailPhys, TotalPageFile, AvailPageFile uint64
	TotalVirtual, AvailVirtual, AvailExtendedVirtual   uint64
}

// Explicit padding keeps the Windows ABI identical on 386, amd64 and arm64.
type ifRow2 struct {
	Luid                                                                    uint64
	Index                                                                   uint32
	GUID                                                                    [16]byte
	Alias, Description                                                      [257]uint16
	PhysicalLength                                                          uint32
	Physical, Permanent                                                     [32]byte
	Mtu, Type, TunnelType, MediaType, PhysicalMedium, AccessType, Direction uint32
	Flags                                                                   uint8
	_                                                                       [3]byte
	OperStatus, AdminStatus, MediaConnectState                              uint32
	NetworkGUID                                                             [16]byte
	ConnectionType                                                          uint32
	_                                                                       uint32
	TransmitSpeed, ReceiveSpeed                                             uint64
	InOctets, InUcastPackets, InNonUcastPackets, InDiscards, InErrors       uint64
	InUnknown, InUcastOctets, InMulticastOctets, InBroadcastOctets          uint64
	OutOctets, OutUcastPackets, OutNonUcastPackets, OutDiscards, OutErrors  uint64
	OutUcastOctets, OutMulticastOctets, OutBroadcastOctets, OutQueueLength  uint64
}

func collectPlatform(c Config) rawMetrics {
	r := rawMetrics{disks: collectVolumes(c), networks: make([]networkCounters, 0, MaxInterfaces)}
	var idle, kernel, user uint64
	if ok, _, _ := getSystemTimes.Call(uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kernel)), uintptr(unsafe.Pointer(&user))); ok != 0 {
		r.cpu = &cpuCounters{total: kernel + user, idle: idle, user: user, system: kernel - idle, detailed: true}
	} else {
		r.unavailable = append(r.unavailable, "cpu")
	}
	var memory memoryStatus
	memory.Length = uint32(unsafe.Sizeof(memory))
	if ok, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&memory))); ok != 0 {
		r.memory = &MemoryMetrics{Total: memory.TotalPhys, Available: memory.AvailPhys, Used: memory.TotalPhys - memory.AvailPhys}
		memoryDetails(r.memory)
	} else {
		r.unavailable = append(r.unavailable, "memory")
	}
	uptime, high, _ := getTickCount64.Call()
	ticks := uint64(uptime)
	if unsafe.Sizeof(uintptr(0)) == 4 {
		ticks |= uint64(high) << 32
	}
	seconds := float64(ticks) / 1000
	r.uptime = &seconds
	interfaces, err := net.Interfaces()
	if err != nil {
		r.unavailable = append(r.unavailable, "network")
		return r
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagLoopback != 0 || !wantedInterface(c, iface.Name) {
			continue
		}
		if len(r.networks) >= MaxInterfaces {
			break
		}
		row := ifRow2{Index: uint32(iface.Index)}
		if code, _, _ := getIfEntry2.Call(uintptr(unsafe.Pointer(&row))); code == 0 {
			r.networks = append(r.networks, networkCounters{name: iface.Name, rx: row.InOctets, tx: row.OutOctets})
		}
	}
	return r
}

type processMemoryCounters struct {
	Size, PageFaultCount                                                       uint32
	PeakWorkingSet, WorkingSet, QuotaPeakPagedPool, QuotaPagedPool             uintptr
	QuotaPeakNonPagedPool, QuotaNonPagedPool, PagefileUsage, PeakPagefileUsage uintptr
}

func ProcessRSS() (uint64, error) {
	var counters processMemoryCounters
	counters.Size = uint32(unsafe.Sizeof(counters))
	if ok, _, _ := getProcessMemoryInfo.Call(^uintptr(0), uintptr(unsafe.Pointer(&counters)), uintptr(counters.Size)); ok == 0 {
		return 0, errors.New("cannot read process working set")
	}
	return uint64(counters.WorkingSet), nil
}

func replaceFile(source, target string) error {
	a, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	b, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	if ok, _, callErr := moveFileEx.Call(uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(b)), 1|8); ok == 0 {
		return callErr
	}
	return nil
}

func lockFile(f *os.File) error {
	var overlapped syscall.Overlapped
	if ok, _, err := lockFileEx.Call(f.Fd(), 3, 0, 1, 0, uintptr(unsafe.Pointer(&overlapped))); ok == 0 {
		return err
	}
	return nil
}

func unlockFile(f *os.File) {
	var overlapped syscall.Overlapped
	_, _, _ = unlockFileEx.Call(f.Fd(), 0, 1, 0, uintptr(unsafe.Pointer(&overlapped)))
}
