//go:build !windows

package agent

import (
	"os"
	"syscall"
)

func replaceFile(source, target string) error { return os.Rename(source, target) }

func lockFile(f *os.File) error { return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) }
func unlockFile(f *os.File)     { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }
