//go:build !linux

package agent

import "os"

func openRunLock(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
}
