//go:build linux

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
	account, err := user.Lookup("spider-watch")
	if err != nil {
		return err
	}
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return err
	}
	gid, err := strconv.Atoi(account.Gid)
	if err != nil {
		return err
	}
	return prepareConfigOwnership(path, uid, gid)
}

func prepareConfigOwnership(path string, uid, gid int) error {
	for _, file := range []string{path, filepath.Join(filepath.Dir(path), "run.lock")} {
		if err := prepareConfigFileOwnership(file, uid, gid); err != nil {
			return err
		}
	}
	return nil
}

func prepareConfigFileOwnership(path string, uid, gid int) error {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		// The installer starts before configuration or a run lock exists.
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("installed service configuration and lock must be regular files")
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if ok && owner.Uid == uint32(uid) && owner.Gid == uint32(gid) {
		// Saving from the service account must not require root privileges.
		return nil
	}
	// Use the verified file descriptor so a concurrent path replacement cannot
	// redirect a privileged configuration operation to another file.
	return f.Chown(uid, gid)
}
func PauseInstalledService(path string) (bool, error) {
	if filepath.Clean(path) != InstalledConfigPath() {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if serviceCommand(ctx, "stop").Run() != nil {
		return false, errors.New("configure the installed service as root")
	}
	return true, nil
}
func StartInstalledService(path string) (string, error) {
	if filepath.Clean(path) != InstalledConfigPath() {
		return "not-installed", nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if serviceCommand(ctx, "restart").Run() != nil {
		return "", errors.New("configuration saved; starting installed service failed (configure must run as root)")
	}
	return "started", nil
}

func serviceCommand(ctx context.Context, action string) *exec.Cmd {
	marker, _ := ReadBounded("/var/lib/spider-watch/service-installed", 64)
	switch string(marker) {
	case "openrc\n":
		return exec.CommandContext(ctx, "rc-service", "spider-watch", action)
	case "procd\n":
		return exec.CommandContext(ctx, "/etc/init.d/spider-watch", action)
	default:
		return exec.CommandContext(ctx, "systemctl", action, "spider-watch.service")
	}
}
