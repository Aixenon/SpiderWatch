//go:build freebsd || openbsd

package agent

import "errors"

func AvailableMemory() (uint64, error) {
	return 0, errors.New("native available RAM adapter unavailable on this unsupported platform")
}
