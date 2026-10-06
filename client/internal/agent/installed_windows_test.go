//go:build windows

package agent

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestServiceFailureCodePreservesIntentionalStops(t *testing.T) {
	for _, err := range []error{nil, context.Canceled, ErrRevoked, ErrInsufficientMemory} {
		if code := serviceFailureCode(err); code != 0 {
			t.Fatalf("intentional stop would trigger SCM recovery: %d", code)
		}
		if err != nil && serviceFailureCode(fmt.Errorf("wrapped: %w", err)) != 0 {
			t.Fatal("wrapped intentional stop would trigger SCM recovery")
		}
	}
	if serviceFailureCode(ErrMemoryBudget) != 75 || serviceFailureCode(fmt.Errorf("wrapped: %w", ErrMemoryBudget)) != 75 {
		t.Fatal("memory-budget exit lost its recovery code")
	}
	if serviceFailureCode(errors.New("unexpected runtime failure")) != 1 {
		t.Fatal("ordinary failure would not trigger recovery")
	}
}
