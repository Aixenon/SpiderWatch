package agent

import (
	"errors"
	"os"
)

// replaceUpdate is deliberately a small transaction. The old image is retained
// until the new image passes its self-check and service activation succeeds.
// Tests inject lifecycle failures without installing any service on the host.
func replaceUpdate(target, staged, backup string, validate, activate, deactivate func() error) error {
	if _, err := os.Lstat(backup); !errors.Is(err, os.ErrNotExist) {
		return errors.New("update backup already exists; inspect the previous update result")
	}
	if err := os.Rename(target, backup); err != nil {
		return errors.New("cannot move current executable; stop foreground agents first")
	}
	if err := os.Rename(staged, target); err != nil {
		if os.Rename(backup, target) != nil {
			return errors.New("update failed and backup restore failed; preserve previous.exe for manual recovery")
		}
		return errors.New("cannot install staged executable; previous executable restored")
	}
	err := validate()
	if err == nil {
		err = activate()
	}
	if err != nil {
		if deactivate() != nil {
			return errors.New("update activation failed and service could not be stopped; previous.exe retained for recovery")
		}
		if os.Rename(target, staged) != nil || os.Rename(backup, target) != nil {
			return errors.New("update failed and executable rollback failed; previous.exe retained for recovery")
		}
		if activate() != nil {
			return errors.New("update rolled back but restarting the previous service failed")
		}
		return errors.New("new executable failed validation or service startup; previous executable restored")
	}
	if err = os.Remove(backup); err != nil {
		return errors.New("update installed but previous executable cleanup failed")
	}
	return nil
}
