//go:build freebsd || openbsd

package agent

func PauseInstalledService(string) (bool, error) { return false, nil }

func InstalledConfigPath() string                  { return "" }
func PrepareInstalledConfig(string) error          { return nil }
func StartInstalledService(string) (string, error) { return "not-installed", nil }
