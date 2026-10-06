//go:build freebsd || openbsd

package agent

import "errors"

func EnforceProcessLimit() error {
	return errors.New("this platform is not production-supported by v0.1")
}
