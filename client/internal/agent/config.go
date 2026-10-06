package agent

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type AccessCredentials struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
}

type Config struct {
	expectedCAHash string            // In-memory updater trust anchor, never loaded from writable JSON.
	Bootstrap      bool              `json:"bootstrap,omitempty"`
	Version        int               `json:"version"`
	Server         string            `json:"server"`
	Group          string            `json:"group"`
	Name           string            `json:"name,omitempty"`
	NodeID         string            `json:"node_id"`
	DeviceKey      string            `json:"device_key"`
	IdentitySeed   string            `json:"identity_seed,omitempty"`
	IdentityMode   string            `json:"identity_mode,omitempty"`
	Invitation     string            `json:"invitation,omitempty"`
	Gate           string            `json:"gate,omitempty"` // Legacy field: read and discard; never transmitted.
	Access         AccessCredentials `json:"access"`
	Interval       int               `json:"interval_seconds"`
	Timeout        int               `json:"timeout_seconds"`
	Interfaces     []string          `json:"interfaces,omitempty"`
	Mounts         []string          `json:"mounts"`
	CAFile         string            `json:"ca_file,omitempty"`
	AllowLocalHTTP bool              `json:"allow_local_http,omitempty"`
}

const NetworkCodeLength = 16

// NormalizeNetworkCode only canonicalizes the new code format. Earlier group
// names (including '-' and '_') keep their existing spelling for compatibility.
func NormalizeNetworkCode(value string) string {
	if len(value) == NetworkCodeLength && isAlphanumericNetworkCode(value) {
		return strings.ToLower(value)
	}
	return value
}

func isAlphanumericNetworkCode(value string) bool {
	return strings.IndexFunc(value, func(r rune) bool {
		return !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	}) < 0
}

func ValidJoinCode(value string) bool {
	if len(value) == NetworkCodeLength && isAlphanumericNetworkCode(value) {
		return true
	}
	// The previously published twelve-digit IDs remain valid join aliases.
	return len(value) == 12 && strings.IndexFunc(value, func(r rune) bool { return r < '0' || r > '9' }) < 0
}

func NewConfig() (Config, error) {
	var identity [48]byte
	if _, err := rand.Read(identity[:]); err != nil {
		return Config{}, err
	}
	// Compact UUIDv4: retain the existing 32-character device ID presentation.
	identity[6] = (identity[6] & 0x0f) | 0x40
	identity[8] = (identity[8] & 0x3f) | 0x80
	c := Config{
		Version: 1, NodeID: hex.EncodeToString(identity[:16]),
		DeviceKey: hex.EncodeToString(identity[16:]), Interval: 300, Timeout: 10,
		Mounts: []string{defaultMount()},
	}
	err := c.EnsureIdentity()
	return c, err
}

func DefaultConfigPath() string {
	if path := InstalledConfigPath(); path != "" {
		return path
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "spider-watch", "config.json")
}

func (c Config) Validate() error {
	if c.Group == "" {
		return errors.New("no network selected; use --join NETWORK_ID first")
	}
	return c.ValidateSetup()
}

// A configured endpoint can exist before membership is requested. Device
// identity is generated once and survives leave, retries and credential changes.
func (c Config) ValidateSetup() error {
	if c.IdentityMode != "" && c.IdentityMode != "ed25519" {
		return errors.New("invalid identity mode")
	}
	if c.IdentitySeed != "" || c.IdentityMode == "ed25519" {
		if _, err := c.identityPrivateKey(); err != nil {
			return err
		}
	}
	if len(c.Invitation) > 256 || len(c.Gate) > 256 || strings.ContainsAny(c.Invitation+c.Gate, "\r\n\x00") {
		return errors.New("invalid enrollment credentials")
	}
	u, err := url.Parse(c.Server)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("server must be an HTTPS origin or base path without credentials, query or fragment")
	}
	if u.Scheme != "https" {
		ip, ipErr := netip.ParseAddr(u.Hostname())
		if !c.AllowLocalHTTP || u.Scheme != "http" || ipErr != nil || !ip.IsLoopback() {
			return errors.New("HTTPS is required; HTTP is allowed only for explicit loopback development")
		}
	}
	if c.Version != 1 || len(c.NodeID) != 32 || len(c.DeviceKey) != 64 {
		return errors.New("invalid configuration version or device identity")
	}
	if _, err := hex.DecodeString(c.NodeID + c.DeviceKey); err != nil {
		return errors.New("invalid device identity encoding")
	}
	if len(c.Group) > 128 || strings.IndexFunc(c.Group, func(r rune) bool {
		return !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-')
	}) >= 0 || len(c.Name) > 128 || len(c.Server) > 2048 {
		return errors.New("invalid group, name or server length")
	}
	if c.Interval < 15 || c.Interval > 3600 || c.Timeout < 1 || c.Timeout > 30 || c.Timeout >= c.Interval {
		return errors.New("interval must be 15..3600 seconds; timeout must be 1..30 seconds and less than interval")
	}
	if len(c.Interfaces) > MaxInterfaces || len(c.Mounts) == 0 || len(c.Mounts) > MaxMounts {
		return errors.New("too many interfaces or mounts")
	}
	for _, value := range append(append([]string{}, c.Interfaces...), c.Mounts...) {
		if len(value) == 0 || len(value) > 512 || strings.ContainsAny(value, "\r\n\x00") {
			return errors.New("invalid interface or mount")
		}
	}
	for _, mount := range c.Mounts {
		if !filepath.IsAbs(mount) {
			return errors.New("mount paths must be absolute")
		}
	}
	if len(c.Access.ClientID) > 256 || len(c.Access.ClientSecret) > 256 ||
		strings.ContainsAny(c.Access.ClientID+c.Access.ClientSecret, "\r\n\x00") {
		return errors.New("invalid Access credentials")
	}
	if (c.Access.ClientID == "") != (c.Access.ClientSecret == "") {
		return errors.New("both Access credential fields are required")
	}
	if u.Scheme == "https" && c.Access.ClientID == "" && !c.Bootstrap && c.IdentityMode != "ed25519" {
		return errors.New("Access credentials are required for HTTPS")
	}
	return nil
}

func ReadBounded(path string, maximum int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maximum+1))
	if err == nil && int64(len(b)) > maximum {
		err = fmt.Errorf("file exceeds %d byte limit", maximum)
	}
	return b, err
}

func decodeOne(data []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("expected a single JSON object")
	}
	return nil
}

func LoadConfig(path string) (Config, error) {
	c, err := LoadSetupConfig(path)
	if err != nil {
		return c, err
	}
	return c, c.Validate()
}

func LoadSetupConfig(path string) (Config, error) {
	var c Config
	b, err := ReadBounded(path, MaxConfigBytes)
	if err != nil {
		return c, err
	}
	if err = decodeOne(b, &c); err != nil {
		return c, fmt.Errorf("invalid config: %w", err)
	}
	c.Group = NormalizeNetworkCode(c.Group)
	c.Gate = ""
	return c, c.ValidateSetup()
}

func LoadAccess(path string) (AccessCredentials, error) {
	var a AccessCredentials
	b, err := ReadBounded(path, 2048)
	if err == nil {
		err = decodeOne(b, &a)
	}
	return a, err
}

func SaveConfig(path string, c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	return SaveSetupConfig(path, c)
}

func SaveSetupConfig(path string, c Config) error {
	c.Group = NormalizeNetworkCode(c.Group)
	if err := c.ValidateSetup(); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil || len(b) > MaxConfigBytes {
		return errors.New("configuration exceeds size limit")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".config-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(b, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = replaceFile(tmp, path); err != nil {
		return err
	}
	// Atomic replacement creates a new file owned by the configuring user.
	// Keep the installed service able to read it, including when enrollment
	// subsequently fails or the service itself saves its Access credentials.
	return PrepareInstalledConfig(path)
}
