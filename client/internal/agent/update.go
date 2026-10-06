package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"runtime"
	"strings"
	"time"
)

const MaxUpdateManifestBytes = 64 << 10

// BuildRevision identifies the source commit bundled with the Worker.
// It is injected at build time and requires no extra file or background task.
var BuildRevision string

type UpdateCheck struct {
	Enabled     bool   `json:"enabled"`
	Version     string `json:"version"`
	Revision    string `json:"revision,omitempty"`
	ReleaseTag  string `json:"release_tag"`
	ManifestURL string `json:"manifest_url"`
}
type UpdateAsset struct {
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	File   string `json:"file"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	URL    string `json:"url"`
}
type UpdateManifest struct {
	Schema     int           `json:"schema"`
	Version    string        `json:"version"`
	Revision   string        `json:"revision,omitempty"`
	ReleaseTag string        `json:"release_tag"`
	Assets     []UpdateAsset `json:"assets"`
}
type UpdatePlan struct {
	Enabled        bool        `json:"enabled"`
	CurrentVersion string      `json:"current_version"`
	Version        string      `json:"version,omitempty"`
	Available      bool        `json:"available"`
	Asset          UpdateAsset `json:"-"`
}

// NewerVersion only installs stable releases. A matching stable release may
// replace its development build; release candidates are never auto-promoted.
func NewerVersion(current, candidate string) (bool, error) {
	a, aPre, aOK := parseReleaseVersion(current)
	b, bPre, bOK := parseReleaseVersion(candidate)
	if !aOK || !bOK || bPre {
		return false, errors.New("updates require a valid stable release version")
	}
	for i := range a {
		if b[i] != a[i] {
			return b[i] > a[i], nil
		}
	}
	return aPre, nil
}

// Resolve only canonical, credential-free, same-origin distribution paths.
// No URL supplied by a response can send device or Access credentials elsewhere.
func (c *Client) updateURL(raw string, manifest bool) (*url.URL, error) {
	base, _ := url.Parse(c.config.Server)
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" ||
		!strings.EqualFold(u.Scheme, base.Scheme) || !strings.EqualFold(u.Host, base.Host) || strings.ContainsAny(u.Path, "\\\x00") || path.Clean(u.Path) != u.Path {
		return nil, errors.New("invalid update distribution URL")
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	if len(parts) < 4 || parts[0] != "v1" || parts[1] != "updates" {
		return nil, errors.New("invalid update distribution path")
	}
	distributionEnd := len(parts) - 1
	if manifest {
		if parts[len(parts)-1] != "manifest.json" {
			return nil, errors.New("invalid update manifest path")
		}
	} else {
		distributionEnd = len(parts) - 3
		if len(parts) < 6 || !validReleaseVersion(parts[len(parts)-3]) || !validDigest(parts[len(parts)-2]) || !validAssetFile(parts[len(parts)-1]) {
			return nil, errors.New("invalid update asset path")
		}
	}
	distribution := strings.Join(parts[2:distributionEnd], "/")
	if len(distribution) > 64 || !validDistributionPath(distribution) {
		return nil, errors.New("invalid update distribution path")
	}
	return u, nil
}

func (c *Client) updateRequest(ctx context.Context, endpoint string, timeout time.Duration) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, errors.New("invalid update request")
	}
	if err := c.authorizeRequest(req, nil); err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json, application/octet-stream")
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "spider-watch/update")
	req.Header.Set("X-Monitor-Update-Protocol", "2")
	if c.config.Access.ClientID != "" {
		req.Header.Set("CF-Access-Client-Id", c.config.Access.ClientID)
		req.Header.Set("CF-Access-Client-Secret", c.config.Access.ClientSecret)
	}
	h := *c.http
	h.Timeout = timeout
	res, err := h.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("update network or TLS request failed")
	}
	if res.StatusCode != http.StatusOK || (res.Header.Get("Content-Encoding") != "" && res.Header.Get("Content-Encoding") != "identity") {
		res.Body.Close()
		return nil, errors.New("update request rejected or unexpectedly encoded")
	}
	return res, nil
}

func (c *Client) updateJSON(ctx context.Context, endpoint string, target any) error {
	res, err := c.updateRequest(ctx, endpoint, time.Duration(c.config.Timeout)*time.Second)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, MaxUpdateManifestBytes+1))
	if err != nil || len(b) > MaxUpdateManifestBytes {
		return errors.New("update metadata exceeds limit or is incomplete")
	}
	if err = decodeOne(b, target); err != nil {
		return errors.New("invalid update metadata")
	}
	return nil
}

func (c *Client) CheckUpdate(ctx context.Context, current string) (UpdatePlan, error) {
	return c.checkUpdate(ctx, current, false)
}

// Automatic checks use the server's per-device policy before reading its bundle.
func (c *Client) CheckAutomaticUpdate(ctx context.Context, current string) (UpdatePlan, error) {
	return c.checkUpdate(ctx, current, true)
}

func (c *Client) checkUpdate(ctx context.Context, current string, automatic bool) (UpdatePlan, error) {
	plan := UpdatePlan{CurrentVersion: current}
	var check UpdateCheck
	endpoint := "/v1/update/check"
	if automatic {
		endpoint = "/v1/update/automatic"
	}
	if err := c.updateJSON(ctx, strings.TrimRight(c.config.Server, "/")+endpoint, &check); err != nil {
		return plan, err
	}
	plan.Enabled = check.Enabled
	if !check.Enabled {
		return plan, nil
	}
	newer, err := NewerVersion(current, check.Version)
	if err != nil {
		return plan, err
	}
	plan.Version = check.Version
	if check.Revision != "" && !validBuildRevision(check.Revision) {
		return plan, errors.New("invalid update build revision")
	}
	// A deployment may rebuild the same release version from a newer commit.
	// The trusted Worker selects that commit; numeric version downgrades stay blocked.
	if !newer && current == check.Version && check.Revision != "" && check.Revision != BuildRevision {
		newer = true
	}
	if !newer {
		return plan, nil
	}
	u, err := c.updateURL(check.ManifestURL, true)
	if err != nil {
		return plan, err
	}
	var manifest UpdateManifest
	if err = c.updateJSON(ctx, u.String(), &manifest); err != nil {
		return plan, err
	}
	if manifest.Schema != 1 || manifest.Version != check.Version || manifest.Revision != check.Revision || manifest.ReleaseTag != check.ReleaseTag || len(manifest.Assets) < 1 || len(manifest.Assets) > 32 {
		return plan, errors.New("update manifest does not match advertised release")
	}
	seen := make(map[string]bool, len(manifest.Assets))
	for _, asset := range manifest.Assets {
		if !validReleasePlatform(asset.OS, asset.Arch) || asset.File != assetFilename(asset.OS, asset.Arch) || seen[asset.OS+"/"+asset.Arch] || asset.Bytes < 1024 || asset.Bytes > MaxBinaryBytes || !validDigest(asset.SHA256) {
			return plan, errors.New("invalid update asset metadata")
		}
		seen[asset.OS+"/"+asset.Arch] = true
		assetURL, err := c.updateURL(asset.URL, false)
		if err != nil {
			return plan, err
		}
		expected := strings.TrimSuffix(u.Path, "manifest.json") + manifest.Version + "/" + asset.SHA256 + "/" + asset.File
		if assetURL.Path != expected {
			return plan, errors.New("update asset does not match manifest path")
		}
		if asset.OS == runtime.GOOS && asset.Arch == releaseArch() {
			plan.Asset = asset
		}
	}
	if plan.Asset.File == "" {
		return plan, errors.New("this release has no update for this platform")
	}
	plan.Available = true
	return plan, nil
}

func validBuildRevision(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// DownloadUpdate streams at most the declared size into a caller-owned temporary
// file. It never buffers the binary, executes it, or changes the live executable.
func (c *Client) DownloadUpdate(ctx context.Context, asset UpdateAsset, destination *os.File) error {
	if asset.Bytes < 1024 || asset.Bytes > MaxBinaryBytes || !validDigest(asset.SHA256) {
		return errors.New("invalid update size or digest")
	}
	u, err := c.updateURL(asset.URL, false)
	if err != nil {
		return err
	}
	res, err := c.updateRequest(ctx, u.String(), 2*time.Minute)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.ContentLength >= 0 && res.ContentLength != asset.Bytes {
		return errors.New("update Content-Length mismatch")
	}
	hash := sha256.New()
	n, err := io.CopyBuffer(io.MultiWriter(destination, hash), io.LimitReader(res.Body, asset.Bytes+1), make([]byte, 32<<10))
	if err != nil || n != asset.Bytes || hex.EncodeToString(hash.Sum(nil)) != asset.SHA256 {
		return errors.New("update size or SHA-256 verification failed")
	}
	if err = destination.Sync(); err != nil {
		return errors.New("cannot sync downloaded update")
	}
	return nil
}

func verifyUpdateFile(file string, asset UpdateAsset) error {
	f, err := os.Open(file)
	if err != nil {
		return errors.New("cannot open staged update")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != asset.Bytes || info.Size() > MaxBinaryBytes {
		return errors.New("invalid staged update size")
	}
	h := sha256.New()
	if _, err = io.CopyBuffer(h, f, make([]byte, 32<<10)); err != nil || fmt.Sprintf("%x", h.Sum(nil)) != asset.SHA256 {
		return errors.New("staged update checksum mismatch")
	}
	return nil
}

func writeUpdateJSON(file string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(file, append(b, '\n'), 0600)
}
