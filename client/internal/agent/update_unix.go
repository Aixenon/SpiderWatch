//go:build !windows

package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Unix renames running executables without a helper copy. The OS scheduler runs
// this bounded operation; collection remains under an unprivileged account.
func (c *Client) ScheduleUpdate(ctx context.Context, plan UpdatePlan, configPath string) (string, error) {
	if !plan.Available || plan.Asset.OS != runtime.GOOS || plan.Asset.Arch != releaseArch() {
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
	installed := configPath == InstalledConfigPath()
	if installed {
		if os.Geteuid() != 0 {
			return "", errors.New("run spider-watch --update with sudo")
		}
		if target != "/opt/spider-watch/spider-watch" {
			return "", errors.New("use the installed spider-watch executable")
		}
		if err = secureRootPath(filepath.Dir(target), true); err != nil {
			return "", err
		}
		if err = secureRootPath(target, false); err != nil {
			return "", err
		}
		if err = ValidateInstalledUpdateSource(configPath, &c.config); err != nil {
			return "", err
		}
	}
	dir := filepath.Join(filepath.Dir(target), ".spider-watch-update")
	if err = os.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("unsafe update directory")
	}
	if installed {
		if err = secureRootPath(dir, true); err != nil {
			return "", err
		}
	}
	guard, err := AcquireLock(filepath.Join(dir, "update.json"))
	if err != nil {
		return "", err
	}
	defer guard.Close()
	if _, err := os.Lstat(filepath.Join(dir, "previous")); !errors.Is(err, os.ErrNotExist) {
		return "", errors.New("previous update needs recovery; inspect the update result before retrying")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "staged-") {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return "", errors.New("unsafe stale update file")
		}
		if err = os.Remove(filepath.Join(dir, entry.Name())); err != nil {
			return "", err
		}
	}
	f, err := os.CreateTemp(dir, "staged-")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	err = c.DownloadUpdate(ctx, plan.Asset, f)
	closeErr := f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err = os.Chmod(f.Name(), 0755); err != nil {
		return "", err
	}
	validate := func() error {
		check, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		output, err := exec.CommandContext(check, target, "version").Output()
		if err != nil || strings.TrimSpace(string(output)) != "spider-watch "+plan.Version {
			return errors.New("new executable self-check failed")
		}
		return nil
	}
	paused, err := PauseInstalledService(configPath)
	if err != nil {
		return "", err
	}
	lock, err := AcquireLock(configPath)
	if err != nil {
		if paused {
			_, _ = StartInstalledService(configPath)
		}
		return "", err
	}
	activate := func() error {
		lock.Close()
		if paused {
			_, err := StartInstalledService(configPath)
			return err
		}
		return nil
	}
	deactivate := func() error {
		if paused {
			_, err := PauseInstalledService(configPath)
			return err
		}
		return nil
	}
	defer lock.Close()
	err = replaceUpdate(target, f.Name(), filepath.Join(dir, "previous"), validate, activate, deactivate)
	lock.Close()
	if err != nil && paused {
		_, _ = StartInstalledService(configPath)
	}
	state := "installed"
	if err != nil {
		state = "failed"
	}
	result := filepath.Join(dir, "result.json")
	if writeErr := writeUpdateJSON(result, map[string]any{"state": state, "version": plan.Version, "time": time.Now().UTC()}); err == nil {
		err = writeErr
	}
	return result, err
}
func ApplyPreparedUpdate(context.Context) error {
	return errors.New("Unix updates run without a helper")
}
