//go:build !windows

package agent

import "context"

func RunAsSystemService([]string, func(context.Context, []string) error) (bool, error) {
	return false, nil
}
