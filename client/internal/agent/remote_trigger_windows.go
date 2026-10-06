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

const remoteUpdateTask = "spider-watch-update-request"

func TriggerRemoteUpdate(ctx context.Context, configPath string) error {
	if err := validateRequestedWindowsInstall(configPath); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	// Resolve the Windows utility from the OS, never PATH or the service's
	// environment. All task arguments are fixed and contain no network data.
	var directory [syscall.MAX_PATH + 1]uint16
	n, _, _ := kernel32.NewProc("GetSystemDirectoryW").Call(uintptr(unsafe.Pointer(&directory[0])), uintptr(len(directory)))
	if n == 0 || n >= uintptr(len(directory)) {
		return errors.New("cannot resolve the Windows system directory")
	}
	command := requestedUpdateTaskCommand(ctx, syscall.UTF16ToString(directory[:n]))
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("cannot start the installed remote update task; rerun the current installer")
	}
	return nil
}

func requestedUpdateTaskCommand(ctx context.Context, systemDirectory string) *exec.Cmd {
	command := exec.CommandContext(ctx, filepath.Join(systemDirectory, "schtasks.exe"), "/Run", "/TN", remoteUpdateTask)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return command
}

func PrepareRequestedUpdate(configPath string) error {
	if err := validateRequestedWindowsInstall(configPath); err != nil {
		return err
	}
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return errors.New("cannot verify requested update privileges")
	}
	defer token.Close()
	var elevated, returned uint32
	if err = syscall.GetTokenInformation(token, syscall.TokenElevation, (*byte)(unsafe.Pointer(&elevated)), uint32(unsafe.Sizeof(elevated)), &returned); err != nil || elevated == 0 {
		return errors.New("requested updates must run through the installed SYSTEM task or as Administrator")
	}
	return nil
}

func validateRequestedWindowsInstall(configPath string) error {
	installed := InstalledConfigPath()
	absolute, err := filepath.Abs(configPath)
	if err != nil || installed == "" || !filepath.IsAbs(installed) || !strings.EqualFold(absolute, filepath.Clean(installed)) || !strings.EqualFold(filepath.Base(filepath.Dir(installed)), "state") {
		return errors.New("remote updates require the installed service configuration")
	}
	executable, err := os.Executable()
	expected := filepath.Join(InstalledBinaryDirectory(), "spider-watch.exe")
	if err != nil || !filepath.IsAbs(expected) || !strings.EqualFold(filepath.Clean(executable), filepath.Clean(expected)) {
		return errors.New("remote updates require the installed executable")
	}
	for _, path := range []string{installed, expected, filepath.Join(filepath.Dir(filepath.Dir(installed)), "service-installed")} {
		if err = validateRemoteWindowsPath(path); err != nil {
			return err
		}
	}
	return nil
}

func validateRemoteWindowsPath(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("remote update paths must be absolute")
	}
	leaf := true
	for current := filepath.Clean(path); ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Win32FileAttributeData)
		if !ok || stat.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (leaf && !info.Mode().IsRegular()) || (!leaf && !info.IsDir()) {
			return errors.New("remote update paths cannot contain redirected or non-regular entries")
		}
		leaf = false
		if filepath.Dir(current) == current {
			return nil
		}
	}
}
