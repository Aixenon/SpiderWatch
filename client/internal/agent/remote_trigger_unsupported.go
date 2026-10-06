//go:build !linux && !darwin && !windows

package agent

import (
	"context"
	"errors"
)

func TriggerRemoteUpdate(context.Context, string) error {
	return errors.New("this platform does not have an installed remote update bridge")
}

func PrepareRequestedUpdate(string) error {
	return errors.New("this platform does not have an installed remote update bridge")
}
