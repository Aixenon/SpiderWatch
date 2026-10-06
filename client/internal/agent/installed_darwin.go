//go:build darwin

package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

const systemConfigPath = "/var/lib/spider-watch/state/config.json"
const launchdLabel = "io.spiderwatch.monitor"
const launchdPlist = "/Library/LaunchDaemons/io.spiderwatch.monitor.plist"

func InstalledConfigPath() string {
	if _, err := os.Stat("/var/lib/spider-watch/service-installed"); err == nil {
		return systemConfigPath
	}
	return ""
}
func PrepareInstalledConfig(path string) error {
	if filepath.Clean(path) != InstalledConfigPath() {
		return nil
	}
	c, err := LoadSetupConfig(path)
	if err != nil {
		return err
	}
	if err = pinUnixUpdateSource(path, c); err != nil {
		return err
	}
	u, err := user.Lookup("_spiderwatch")
	if err != nil {
		return err
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return err
	}
	gid, err := strconv.Atoi(u.Gid)
	if err != nil {
		return err
	}
	for _, p := range []string{path, filepath.Join(filepath.Dir(path), "run.lock")} {
		f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		info, err := f.Stat()
		if err == nil && !info.Mode().IsRegular() {
			err = errors.New("configuration must be a regular file")
		}
		if err == nil && os.Geteuid() == 0 {
			err = f.Chown(uid, gid)
		}
		f.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
func launchctl(args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "/bin/launchctl", args...).Run()
}
func PauseInstalledService(path string) (bool, error) {
	if filepath.Clean(path) != InstalledConfigPath() {
		return false, nil
	}
	if os.Geteuid() != 0 {
		return false, errors.New("configure the installed service with sudo")
	}
	if launchctl("print", "system/"+launchdLabel) == nil {
		if err := launchctl("bootout", "system/"+launchdLabel); err != nil {
			return false, err
		}
	}
	return true, nil
}
func StartInstalledService(path string) (string, error) {
	if filepath.Clean(path) != InstalledConfigPath() {
		return "not-installed", nil
	}
	if launchctl("print", "system/"+launchdLabel) == nil {
		return "started", launchctl("kickstart", "-k", "system/"+launchdLabel)
	}
	return "started", launchctl("bootstrap", "system", launchdPlist)
}
