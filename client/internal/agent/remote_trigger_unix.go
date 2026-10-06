//go:build linux || darwin

package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

const remoteRequestMarker = "update-request"

// The marker carries no job, command, path or credentials. The privileged
// one-shot fetches the authenticated request itself after consuming the marker.
func TriggerRemoteUpdate(ctx context.Context, configPath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	state, err := requestedUpdateState(configPath)
	if err != nil {
		return err
	}
	defer state.Close()
	return writeRequestedUpdateMarker(state)
}

// PrepareRequestedUpdate must run before fetching a job, including when no job
// is available, so a persistent path watch cannot repeatedly launch the updater.
func PrepareRequestedUpdate(configPath string) error {
	if os.Geteuid() != 0 {
		return errors.New("requested updates must run through the installed privileged update bridge")
	}
	state, err := requestedUpdateState(configPath)
	if err != nil {
		return err
	}
	defer state.Close()
	return consumeRequestedUpdateMarker(state)
}

func requestedUpdateState(configPath string) (*os.Root, error) {
	absolute, err := filepath.Abs(configPath)
	if err != nil || absolute != systemConfigPath || InstalledConfigPath() != systemConfigPath {
		return nil, errors.New("remote updates require the installed service configuration")
	}
	executable, err := os.Executable()
	if err != nil || executable != "/opt/spider-watch/spider-watch" {
		return nil, errors.New("remote updates require the installed executable")
	}
	for _, path := range []string{"/opt", "/opt/spider-watch", "/var/lib", "/var/lib/spider-watch"} {
		if err = secureRootPath(path, true); err != nil {
			return nil, err
		}
	}
	for _, path := range []string{executable, "/var/lib/spider-watch/service-installed", "/var/lib/spider-watch/update-request-installed"} {
		if err = secureRootPath(path, false); err != nil {
			return nil, errors.New("remote update bridge is missing or unsafe; rerun the current installer")
		}
		if info, statErr := os.Lstat(path); statErr != nil || !info.Mode().IsRegular() {
			return nil, errors.New("remote update bridge files must be regular files")
		}
	}
	bridge, err := ReadBounded("/var/lib/spider-watch/update-request-installed", 32)
	manager := strings.TrimSpace(string(bridge))
	if err != nil || (runtime.GOOS == "darwin" && manager != "launchd") || (runtime.GOOS == "linux" && manager != "systemd" && manager != "openrc" && manager != "procd") {
		return nil, errors.New("remote update bridge is unavailable; rerun the current installer")
	}
	root, err := os.OpenRoot("/var/lib/spider-watch")
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Lstat("state")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("unsafe installed state directory")
	}
	state, err := root.OpenRoot("state")
	if err != nil {
		return nil, err
	}
	info, err = state.Lstat("config.json")
	if err != nil || !info.Mode().IsRegular() {
		state.Close()
		return nil, errors.New("installed configuration must be a regular file")
	}
	return state, nil
}

func validRequestedUpdateMarker(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && info.Mode().IsRegular() && info.Size() == 0 && stat.Nlink == 1
}

func writeRequestedUpdateMarker(state *os.Root) error {
	// O_EXCL prevents following links or modifying an existing file. An empty
	// regular marker already present means a request is waiting to be handled.
	f, err := state.OpenFile(remoteRequestMarker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		info, statErr := state.Lstat(remoteRequestMarker)
		if statErr == nil && validRequestedUpdateMarker(info) {
			return nil
		}
		return errors.New("unsafe update request marker")
	}
	if err != nil {
		return err
	}
	return f.Close()
}

func consumeRequestedUpdateMarker(state *os.Root) error {
	info, err := state.Lstat(remoteRequestMarker)
	if err != nil {
		return errors.New("no local update request is pending")
	}
	if !validRequestedUpdateMarker(info) {
		// Remove only the fixed entry. Root.Remove unlinks a substituted symlink
		// itself, never its target; clearing malformed entries also stops watches.
		_ = state.Remove(remoteRequestMarker)
		return errors.New("unsafe update request marker")
	}
	return state.Remove(remoteRequestMarker)
}
