//go:build !windows

package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

type unixUpdateSource struct {
	Server         string `json:"server"`
	CAHash         string `json:"ca_sha256"`
	AllowLocalHTTP bool   `json:"allow_local_http"`
}

func unixSource(c Config) (unixUpdateSource, error) {
	v := unixUpdateSource{Server: c.Server, AllowLocalHTTP: c.AllowLocalHTTP}
	if c.CAFile != "" {
		data, err := ReadBounded(c.CAFile, MaxCABytes)
		if err != nil {
			return v, err
		}
		h := sha256.Sum256(data)
		v.CAHash = hex.EncodeToString(h[:])
	}
	return v, nil
}
func secureRootPath(path string, directory bool) error {
	i, err := os.Lstat(path)
	if err != nil {
		return err
	}
	s, ok := i.Sys().(*syscall.Stat_t)
	if !ok || s.Uid != 0 || i.Mode().Perm()&0022 != 0 || i.Mode()&os.ModeSymlink != 0 || i.IsDir() != directory {
		return errors.New("update path must be root-owned and not group/world writable")
	}
	return nil
}
func unixPinPath(path string) string {
	return filepath.Join(filepath.Dir(filepath.Dir(path)), "update-source.json")
}
func pinUnixUpdateSource(path string, c Config) error {
	source, err := unixSource(c)
	if err != nil {
		return err
	}
	file := unixPinPath(path)
	var existing unixUpdateSource
	if data, e := ReadBounded(file, 4096); e == nil && decodeOne(data, &existing) == nil && existing == source && secureRootPath(file, false) == nil {
		return nil
	}
	if os.Geteuid() != 0 {
		return errors.New("changing the installed update source requires sudo configure")
	}
	if err = secureRootPath(filepath.Dir(file), true); err != nil {
		return err
	}
	if _, err = os.Lstat(file); err == nil {
		if err = secureRootPath(file, false); err != nil {
			return err
		}
	}
	if err = writeUpdateJSON(file, source); err != nil {
		return err
	}
	return os.Chmod(file, 0644)
}
func ValidateInstalledUpdateSource(path string, c *Config) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if absolute != InstalledConfigPath() {
		return nil
	}
	file := unixPinPath(absolute)
	if err = secureRootPath(filepath.Dir(file), true); err != nil {
		return err
	}
	if err = secureRootPath(file, false); err != nil {
		return err
	}
	var pinned unixUpdateSource
	data, err := ReadBounded(file, 4096)
	if err != nil {
		return err
	}
	expected, err := unixSource(*c)
	if err != nil {
		return err
	}
	if decodeOne(data, &pinned) != nil || expected != pinned {
		return errors.New("update source changed; run sudo configure")
	}
	c.expectedCAHash = pinned.CAHash
	return nil
}
