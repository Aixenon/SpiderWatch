package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type RunLock struct{ file *os.File }

func AcquireLock(configPath string) (*RunLock, error) {
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := openRunLock(filepath.Join(dir, "run.lock"))
	if err != nil {
		return nil, err
	}
	if err = lockFile(f); err != nil {
		_ = f.Close()
		return nil, errors.New("another agent operation is running; stop the service first")
	}
	if err = f.Truncate(0); err == nil {
		_, err = fmt.Fprintf(f, "%d\n", os.Getpid())
	}
	if err != nil {
		unlockFile(f)
		_ = f.Close()
		return nil, err
	}
	return &RunLock{file: f}, nil
}

func (l *RunLock) Close() {
	if l.file != nil {
		unlockFile(l.file)
		_ = l.file.Close()
		l.file = nil
	}
}
