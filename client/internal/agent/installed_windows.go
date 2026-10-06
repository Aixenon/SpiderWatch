//go:build windows

package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

func InstalledConfigPath() string {
	path := filepath.Join(os.Getenv("ProgramData"), "spider-watch")
	if _, err := os.Stat(filepath.Join(path, "service-installed")); err == nil {
		if marker, readErr := ReadBounded(filepath.Join(path, "service-installed"), 64); readErr == nil && strings.TrimSpace(string(marker)) == "state-v2" {
			return filepath.Join(path, "state", "config.json")
		}
		return filepath.Join(path, "config.json")
	}
	return ""
}

// Windows path spelling is not identity. Always resolve installed operations
// against the canonical installation, including case variants and hard links.
func isInstalledConfig(path string) bool {
	installed := InstalledConfigPath()
	if installed == "" {
		return false
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	if strings.EqualFold(filepath.Clean(absolute), filepath.Clean(installed)) {
		return true
	}
	a, e1 := os.Stat(absolute)
	b, e2 := os.Stat(installed)
	return e1 == nil && e2 == nil && os.SameFile(a, b)
}
func PrepareInstalledConfig(path string) error {
	// Only the configuration directory is writable by LocalService. The
	// administrator-owned update source must not follow later service tampering.
	if !isInstalledConfig(path) || !strings.EqualFold(filepath.Base(filepath.Dir(InstalledConfigPath())), "state") {
		return nil
	}
	path = InstalledConfigPath()
	c, err := LoadSetupConfig(path)
	if err != nil {
		return err
	}
	return pinInstalledUpdateSource(path, c)
}
func PauseInstalledService(path string) (bool, error) {
	if !isInstalledConfig(path) {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "sc.exe", "stop", "spider-watch").Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1062 {
			return true, nil
		}
		return false, errors.New("configure the installed service as Administrator")
	}
	// sc stop returns while STOP_PENDING. Wait for SCM to release the old
	// process before acquiring its configuration lock.
	manager, _, _ := advapi32.NewProc("OpenSCManagerW").Call(0, 0, 1)
	if manager == 0 {
		return false, errors.New("cannot query service manager")
	}
	closeHandle := advapi32.NewProc("CloseServiceHandle")
	defer closeHandle.Call(manager)
	name, _ := syscall.UTF16PtrFromString("spider-watch")
	service, _, _ := advapi32.NewProc("OpenServiceW").Call(manager, uintptr(unsafe.Pointer(name)), 4)
	if service == 0 {
		return false, errors.New("cannot query installed service")
	}
	defer closeHandle.Call(service)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		var status serviceStatus
		ok, _, _ := advapi32.NewProc("QueryServiceStatus").Call(service, uintptr(unsafe.Pointer(&status)))
		if ok == 0 {
			return false, errors.New("cannot query service state")
		}
		if status.state == 1 {
			return true, nil
		}
		select {
		case <-ctx.Done():
			return false, errors.New("stopping installed service timed out")
		case <-ticker.C:
		}
	}
}
func StartInstalledService(path string) (string, error) {
	if !isInstalledConfig(path) {
		return "not-installed", nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "sc.exe", "start", "spider-watch").Run(); err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1056 {
			return "", errors.New("configuration saved; starting service failed (run configure as Administrator)")
		}
	}
	return "started", nil
}

// SCM integration uses the Windows API already used by the native collector.
// The agent remains a single executable without an external service wrapper.
var advapi32 = syscall.NewLazyDLL("advapi32.dll")
var startServiceDispatcher = advapi32.NewProc("StartServiceCtrlDispatcherW")
var registerServiceHandler = advapi32.NewProc("RegisterServiceCtrlHandlerExW")
var setServiceStatus = advapi32.NewProc("SetServiceStatus")

type serviceEntry struct {
	name     *uint16
	callback uintptr
}
type serviceStatus struct{ kind, state, accepts, win32Exit, serviceExit, checkpoint, waitHint uint32 }

func serviceFailureCode(err error) uint32 {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, ErrRevoked) || errors.Is(err, ErrInsufficientMemory) {
		// Intentional stops must report success to SCM so configured recovery
		// does not repeatedly restart a removed device or a low-RAM system.
		return 0
	}
	if errors.Is(err, ErrMemoryBudget) {
		return 75
	}
	return 1
}

func RunAsSystemService(args []string, run func(context.Context, []string) error) (bool, error) {
	if len(args) == 0 || args[0] != "service-run" {
		return false, nil
	}
	name, _ := syscall.UTF16PtrFromString("spider-watch")
	var result error
	callback := syscall.NewCallback(func(uintptr, uintptr) uintptr {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		var handle uintptr
		status := func(state, accepts, exit uint32) {
			value := serviceStatus{kind: 16, state: state, accepts: accepts, serviceExit: exit}
			if exit != 0 {
				value.win32Exit = 1066
			}
			setServiceStatus.Call(handle, uintptr(unsafe.Pointer(&value)))
		}
		handler := syscall.NewCallback(func(control, event, data, extra uintptr) uintptr {
			if control == 1 || control == 5 {
				status(3, 0, 0)
				cancel()
			}
			return 0
		})
		handle, _, _ = registerServiceHandler.Call(uintptr(unsafe.Pointer(name)), handler, 0)
		if handle == 0 {
			result = errors.New("cannot register service handler")
			return 0
		}
		status(4, 5, 0)
		result = run(ctx, append([]string{"run", "--wait-config"}, args[1:]...))
		status(1, 0, serviceFailureCode(result))
		return 0
	})
	table := [2]serviceEntry{{name: name, callback: callback}, {}}
	ok, _, _ := startServiceDispatcher.Call(uintptr(unsafe.Pointer(&table[0])))
	if ok == 0 {
		return true, errors.New("service-run must be launched by the Windows service manager")
	}
	return true, result
}

// ProgramFiles is separate from writable ProgramData state. Use the native
// Program Files even for an x86 process running on a 64-bit Windows host.
func InstalledBinaryDirectory() string {
	base := os.Getenv("ProgramW6432")
	if base == "" {
		base = os.Getenv("ProgramFiles")
	}
	return filepath.Join(base, "SpiderWatch")
}
