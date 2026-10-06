//go:build windows

package agent

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

type updateJob struct {
	Target    string      `json:"target"`
	Config    string      `json:"config"`
	Version   string      `json:"version"`
	ParentPID int         `json:"parent_pid"`
	Asset     UpdateAsset `json:"asset"`
}

type updateSource struct {
	Server         string `json:"server"`
	CAHash         string `json:"ca_sha256"`
	AllowLocalHTTP bool   `json:"allow_local_http"`
}

func configuredUpdateSource(c Config) (updateSource, error) {
	source := updateSource{Server: c.Server, AllowLocalHTTP: c.AllowLocalHTTP}
	if c.CAFile != "" {
		data, err := ReadBounded(c.CAFile, MaxCABytes)
		if err != nil {
			return source, errors.New("cannot verify configured update CA")
		}
		digest := sha256.Sum256(data)
		source.CAHash = hex.EncodeToString(digest[:])
	}
	return source, nil
}

func pinInstalledUpdateSource(configPath string, c Config) error {
	source, err := configuredUpdateSource(c)
	if err != nil {
		return err
	}
	file := filepath.Join(filepath.Dir(filepath.Dir(configPath)), "update-source.json")
	var existing updateSource
	if data, readErr := ReadBounded(file, 4096); readErr == nil && decodeOne(data, &existing) == nil && existing == source {
		return nil
	}
	// The protected installation root makes this write Administrator-only.
	if err = writeUpdateJSON(file, source); err != nil {
		return errors.New("updating the installed server or CA requires Administrator configure")
	}
	if err = protectUpdatePath(file, false, true); err != nil {
		return err
	}
	return nil
}

func ValidateInstalledUpdateSource(configPath string, c *Config) error {
	absolute, err := filepath.Abs(configPath)
	if err != nil {
		return err
	}
	if !isInstalledConfig(absolute) {
		return nil
	}
	absolute = InstalledConfigPath()
	if filepath.Base(filepath.Dir(absolute)) != "state" {
		return errors.New("legacy installation: rerun the current installer to secure the update source before using Worker updates")
	}
	expected, err := configuredUpdateSource(*c)
	if err != nil {
		return err
	}
	var pinned updateSource
	data, err := ReadBounded(filepath.Join(filepath.Dir(filepath.Dir(absolute)), "update-source.json"), 4096)
	if err != nil || decodeOne(data, &pinned) != nil || pinned != expected {
		return errors.New("update server or CA differs from the administrator configuration; run configure as Administrator")
	}
	c.expectedCAHash = pinned.CAHash
	return nil
}

type updateResult struct {
	State     string    `json:"state"`
	Version   string    `json:"version"`
	HelperPID int       `json:"helper_pid,omitempty"`
	Message   string    `json:"message,omitempty"`
	Time      time.Time `json:"time"`
}

func regularUpdateFile(file string) bool {
	info, err := os.Lstat(file)
	return err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0
}

func privateUpdateDirectory(target string) (string, error) {
	dir := filepath.Join(filepath.Dir(target), ".spider-watch-update")
	if err := os.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", errors.New("update needs write permission beside the executable; run the installed agent as Administrator")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("unsafe update directory")
	}
	return dir, nil
}

func processRunning(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := syscall.OpenProcess(0x100000, false, uint32(pid))
	if err != nil {
		return err == syscall.ERROR_ACCESS_DENIED
	}
	defer syscall.CloseHandle(h)
	status, _ := syscall.WaitForSingleObject(h, 0)
	return status == syscall.WAIT_TIMEOUT
}

// ScheduleUpdate launches a copy of THIS executable, never a downloaded script.
// The helper opens the parent process handle before signalling readiness, and
// waits for parent exit before touching the live executable.
func (c *Client) ScheduleUpdate(ctx context.Context, plan UpdatePlan, configPath string) (string, error) {
	if !plan.Enabled || !plan.Available || plan.Asset.OS != "windows" {
		return "", errors.New("no installable update")
	}
	target, err := os.Executable()
	if err != nil {
		return "", err
	}
	target, err = filepath.EvalSymlinks(target)
	if err != nil {
		return "", err
	}
	configPath, err = filepath.Abs(configPath)
	if err != nil {
		return "", err
	}
	installed := isInstalledConfig(configPath)
	if installed {
		configPath = InstalledConfigPath()
		if filepath.Base(filepath.Dir(configPath)) != "state" {
			return "", errors.New("legacy writable installation layout: rerun the current installer once to migrate credentials into state before updating")
		}
		if !strings.EqualFold(target, filepath.Join(InstalledBinaryDirectory(), "spider-watch.exe")) {
			return "", errors.New("run --update using the installed spider-watch.exe")
		}
		if err = protectUpdatePath(filepath.Dir(target), true, true); err != nil {
			return "", err
		}
		if err = protectUpdatePath(target, false, true); err != nil {
			return "", err
		}
	}
	dir, err := privateUpdateDirectory(target)
	if err != nil {
		return "", err
	}
	if installed {
		if err = protectUpdatePath(dir, true, false); err != nil {
			return "", err
		}
	}
	guard, err := AcquireLock(filepath.Join(dir, "update.json"))
	if err != nil {
		return "", errors.New("another update is running")
	}
	defer guard.Close()
	resultPath := filepath.Join(filepath.Dir(target), "update-result.json")
	if b, readErr := ReadBounded(resultPath, 2048); readErr == nil {
		var previous updateResult
		if decodeOne(b, &previous) == nil && previous.State == "installing" && processRunning(previous.HelperPID) {
			return "", errors.New("another update is still installing")
		}
	}
	// A retained backup means recovery needs inspection, never silently delete it.
	if _, e := os.Lstat(filepath.Join(dir, "previous.exe")); !errors.Is(e, os.ErrNotExist) {
		return "", errors.New("previous update needs recovery; inspect update-result.json")
	}
	for _, name := range []string{"helper.exe", "staged.exe", "job.json", "ready"} {
		file := filepath.Join(dir, name)
		if info, e := os.Lstat(file); e == nil {
			if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return "", errors.New("unsafe pending update file")
			}
			if os.Remove(file) != nil {
				return "", errors.New("cannot clean a previous update; it may still be running")
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			return "", e
		}
	}
	staged, err := os.OpenFile(filepath.Join(dir, "staged.exe"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return "", errors.New("cannot stage update")
	}
	err = c.DownloadUpdate(ctx, plan.Asset, staged)
	closeErr := staged.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(staged.Name())
		return "", err
	}
	current, err := os.Open(target)
	if err != nil {
		return "", err
	}
	defer current.Close()
	info, err := current.Stat()
	if err != nil || info.Size() > MaxBinaryBytes {
		return "", errors.New("current executable exceeds update disk budget")
	}
	helper, err := os.OpenFile(filepath.Join(dir, "helper.exe"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return "", err
	}
	_, err = io.CopyBuffer(helper, io.LimitReader(current, MaxBinaryBytes+1), make([]byte, 32<<10))
	if err == nil {
		err = helper.Sync()
	}
	closeErr = helper.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", errors.New("cannot prepare trusted update helper")
	}
	job := updateJob{Target: target, Config: configPath, Version: plan.Version, ParentPID: os.Getpid(), Asset: plan.Asset}
	if err = writeUpdateJSON(filepath.Join(dir, "job.json"), job); err != nil {
		return "", err
	}
	command := exec.Command(helper.Name(), "internal-apply-update")
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err = command.Start(); err != nil {
		return "", errors.New("cannot start local update helper")
	}
	result := updateResult{State: "installing", Version: plan.Version, HelperPID: command.Process.Pid, Time: time.Now().UTC()}
	if err = writeUpdateJSON(resultPath, result); err != nil {
		_ = command.Process.Kill()
		return "", errors.New("cannot record pending update")
	}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = command.Process.Kill()
			return "", ctx.Err()
		case <-deadline.C:
			_ = command.Process.Kill()
			return "", errors.New("update helper did not become ready; executable unchanged")
		case <-tick.C:
			if regularUpdateFile(filepath.Join(dir, "ready")) {
				_ = command.Process.Release()
				return resultPath, nil
			}
			if !processRunning(command.Process.Pid) {
				return "", errors.New("update helper could not start; executable unchanged")
			}
		}
	}
}

func waitUpdateParent(ctx context.Context, pid int, ready string) error {
	if pid <= 0 || pid == os.Getpid() {
		return errors.New("invalid update parent")
	}
	h, err := syscall.OpenProcess(0x100000, false, uint32(pid))
	if err != nil {
		return errors.New("cannot wait for update parent")
	}
	defer syscall.CloseHandle(h)
	if err = os.WriteFile(ready, []byte("ready\n"), 0600); err != nil {
		return err
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		state, err := syscall.WaitForSingleObject(h, 100)
		if err != nil {
			return err
		}
		if state == syscall.WAIT_OBJECT_0 {
			return nil
		}
	}
	return errors.New("update parent did not exit; executable unchanged")
}

func installedServiceRunning(ctx context.Context) error {
	manager, _, _ := advapi32.NewProc("OpenSCManagerW").Call(0, 0, 1)
	if manager == 0 {
		return errors.New("cannot query installed service")
	}
	defer advapi32.NewProc("CloseServiceHandle").Call(manager)
	name, _ := syscall.UTF16PtrFromString("spider-watch")
	service, _, _ := advapi32.NewProc("OpenServiceW").Call(manager, uintptr(unsafe.Pointer(name)), 4)
	if service == 0 {
		return errors.New("cannot open installed service")
	}
	defer advapi32.NewProc("CloseServiceHandle").Call(service)
	// Give early failures (invalid runtime/startup-memory/config) time to surface.
	deadline, stableSince := time.Now().Add(15*time.Second), time.Time{}
	for time.Now().Before(deadline) {
		var status serviceStatus
		ok, _, _ := advapi32.NewProc("QueryServiceStatus").Call(service, uintptr(unsafe.Pointer(&status)))
		if ok == 0 || status.state == 1 {
			return errors.New("updated service did not stay running")
		}
		if status.state == 4 {
			if stableSince.IsZero() {
				stableSince = time.Now()
			}
			if time.Since(stableSince) >= 2*time.Second {
				return nil
			}
		} else {
			stableSince = time.Time{}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return errors.New("updated service start timed out")
}

func ApplyPreparedUpdate(ctx context.Context) (resultErr error) {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	dir := filepath.Dir(executable)
	if filepath.Base(executable) != "helper.exe" || filepath.Base(dir) != ".spider-watch-update" {
		return errors.New("internal updater must run from its prepared directory")
	}
	var job updateJob
	data, err := ReadBounded(filepath.Join(dir, "job.json"), MaxConfigBytes)
	if err != nil || decodeOne(data, &job) != nil {
		return errors.New("invalid prepared update job")
	}
	if !filepath.IsAbs(job.Target) || filepath.Clean(filepath.Dir(job.Target)) != filepath.Clean(filepath.Dir(dir)) || !filepath.IsAbs(job.Config) || !regularUpdateFile(job.Target) || job.Version == "" {
		return errors.New("unsafe prepared update paths")
	}
	resultPath := filepath.Join(filepath.Dir(dir), "update-result.json")
	defer func() {
		result := updateResult{State: "installed", Version: job.Version, Time: time.Now().UTC()}
		if resultErr != nil {
			result.State = "failed"
			result.Message = resultErr.Error()
		}
		_ = writeUpdateJSON(resultPath, result)
		for _, name := range []string{"staged.exe", "job.json", "ready"} {
			_ = os.Remove(filepath.Join(dir, name))
		}
		// helper.exe is still mapped. The next update removes this one retained
		// helper before staging; no unbounded per-release cache accumulates.
	}()
	if err = waitUpdateParent(ctx, job.ParentPID, filepath.Join(dir, "ready")); err != nil {
		return err
	}
	guard, err := AcquireLock(filepath.Join(dir, "job.json"))
	if err != nil {
		return errors.New("another update acquired the installer lock")
	}
	defer guard.Close()
	staged := filepath.Join(dir, "staged.exe")
	if !regularUpdateFile(staged) {
		return errors.New("unsafe staged executable")
	}
	if err = verifyUpdateFile(staged, job.Asset); err != nil {
		return err
	}
	if err = validateWindowsImage(staged, job.Asset.Arch); err != nil {
		return err
	}
	restart, err := updateServiceWasRunning(job.Config)
	if err != nil {
		return err
	}
	var operation *RunLock
	// Install a restoration guard BEFORE the stop operation. A successful stop
	// followed by an SCM query error must not leave the old service stopped.
	serviceStopped := restart
	defer func() {
		if operation != nil {
			operation.Close()
		}
		if serviceStopped {
			_, startErr := StartInstalledService(job.Config)
			if startErr != nil {
				resultErr = errors.Join(resultErr, errors.New("could not restore installed service"))
			}
		}
	}()
	if _, err = PauseInstalledService(job.Config); err != nil {
		return err
	}
	operation, err = AcquireLock(job.Config)
	if err != nil {
		return errors.New("foreground agent is running; stop it before updating")
	}
	validate := func() error {
		if isInstalledConfig(job.Config) {
			if err := protectUpdatePath(job.Target, false, true); err != nil {
				return err
			}
		}
		checkContext, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(checkContext, job.Target, "version")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		output := &limitedUpdateOutput{}
		cmd.Stdout, cmd.Stderr = output, io.Discard
		if cmd.Run() != nil || strings.TrimSpace(string(output.data)) != "spider-watch "+job.Version {
			return errors.New("new executable self-check failed")
		}
		return nil
	}
	activate := func() error {
		if operation != nil {
			operation.Close()
			operation = nil
		}
		if !restart {
			return nil
		}
		if _, err := StartInstalledService(job.Config); err != nil {
			return err
		}
		serviceStopped = false
		return installedServiceRunning(ctx)
	}
	deactivate := func() error {
		if restart && !serviceStopped {
			if _, err := PauseInstalledService(job.Config); err != nil {
				return err
			}
			serviceStopped = true
		}
		if operation == nil {
			operation, err = AcquireLock(job.Config)
			return err
		}
		return nil
	}
	return replaceUpdate(job.Target, staged, filepath.Join(dir, "previous.exe"), validate, activate, deactivate)
}

func protectUpdatePath(path string, directory, serviceRead bool) error {
	inherit := ""
	if directory {
		inherit = "OICI"
	}
	sddl := "O:BAD:P(A;" + inherit + ";FA;;;SY)(A;" + inherit + ";FA;;;BA)"
	if serviceRead {
		sddl += "(A;" + inherit + ";GRGX;;;S-1-5-19)"
	}
	text, _ := syscall.UTF16PtrFromString(sddl)
	var descriptor uintptr
	if ok, _, _ := advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0); ok == 0 {
		return errors.New("cannot build private updater ACL")
	}
	defer kernel32.NewProc("LocalFree").Call(descriptor)
	name, _ := syscall.UTF16PtrFromString(path)
	if ok, _, _ := advapi32.NewProc("SetFileSecurityW").Call(uintptr(unsafe.Pointer(name)), 0x80000005, descriptor); ok == 0 {
		return errors.New("update requires Administrator permission to protect installed executable files")
	}
	return nil
}

func updateServiceWasRunning(configPath string) (bool, error) {
	if !isInstalledConfig(configPath) {
		return false, nil
	}
	manager, _, _ := advapi32.NewProc("OpenSCManagerW").Call(0, 0, 1)
	if manager == 0 {
		return false, errors.New("cannot query installed service before update")
	}
	defer advapi32.NewProc("CloseServiceHandle").Call(manager)
	name, _ := syscall.UTF16PtrFromString("spider-watch")
	service, _, _ := advapi32.NewProc("OpenServiceW").Call(manager, uintptr(unsafe.Pointer(name)), 4)
	if service == 0 {
		return false, errors.New("cannot inspect installed service before update")
	}
	defer advapi32.NewProc("CloseServiceHandle").Call(service)
	var status serviceStatus
	if ok, _, _ := advapi32.NewProc("QueryServiceStatus").Call(service, uintptr(unsafe.Pointer(&status))); ok == 0 {
		return false, errors.New("cannot inspect installed service state")
	}
	return status.state != 1, nil
}

type limitedUpdateOutput struct{ data []byte }

func validateWindowsImage(file, arch string) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	var header [64]byte
	if _, err = io.ReadFull(f, header[:]); err != nil || string(header[:2]) != "MZ" {
		return errors.New("update is not a Windows executable")
	}
	offset := int64(binary.LittleEndian.Uint32(header[60:64]))
	if offset < 64 || offset > MaxBinaryBytes-6 {
		return errors.New("invalid executable header offset")
	}
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	var signature [6]byte
	if _, err = io.ReadFull(f, signature[:]); err != nil || string(signature[:4]) != "PE\x00\x00" {
		return errors.New("invalid Windows executable signature")
	}
	machine := map[string]uint16{"amd64": 0x8664, "arm64": 0xaa64, "386": 0x14c}[arch]
	if machine == 0 || binary.LittleEndian.Uint16(signature[4:6]) != machine {
		return errors.New("update executable architecture mismatch")
	}
	return nil
}

func (b *limitedUpdateOutput) Write(p []byte) (int, error) {
	if len(b.data)+len(p) > 256 {
		return 0, errors.New("update self-check output exceeds limit")
	}
	b.data = append(b.data, p...)
	return len(p), nil
}
