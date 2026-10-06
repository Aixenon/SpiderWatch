package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"
)

const MinimumAvailableBytes = 16 * MiB

var ErrInsufficientMemory = errors.New("available system RAM is below 16 MiB")

func checkAvailableMemory(available uint64) error {
	if available < MinimumAvailableBytes {
		return fmt.Errorf("%w (%d bytes available)", ErrInsufficientMemory, available)
	}
	return nil
}
func CheckStartupMemory() error {
	available, err := AvailableMemory()
	if err != nil {
		return fmt.Errorf("cannot verify available system RAM: %w", err)
	}
	return checkAvailableMemory(available)
}
func WaitForConfig(ctx context.Context, path string) error {
	// Installation enables the service before configure. No network traffic or
	// collector is created until a complete network configuration exists.
	timer := time.NewTicker(5 * time.Second)
	defer timer.Stop()
	for {
		if c, err := LoadSetupConfig(path); err == nil && c.Group != "" {
			return nil
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
}
