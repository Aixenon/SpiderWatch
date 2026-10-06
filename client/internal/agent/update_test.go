package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestUpdateNeverDowngradesOrInstallsPrereleases(t *testing.T) {
	for _, row := range []struct {
		current, next  string
		newer, invalid bool
	}{
		{"0.3.0", "0.4.0", true, false}, {"0.4.0", "0.4.0", false, false},
		{"1.0.0", "0.99.99", false, false}, {"0.4.0-dev", "0.4.0", true, false},
		{"0.4.0", "0.5.0-rc1", false, true}, {"0.4.0", "0.04.1", false, true},
		{"bad", "0.4.0", false, true}, {"0.4.0", "9999999999999.0.0", false, true},
	} {
		got, err := NewerVersion(row.current, row.next)
		if got != row.newer || (err != nil) != row.invalid {
			t.Fatalf("%s -> %s: %v %v", row.current, row.next, got, err)
		}
	}
}

func TestCollectorReportsTheReleaseArchitectureForUpdateSelection(t *testing.T) {
	previous := BuildArch
	t.Cleanup(func() { BuildArch = previous })
	for _, arch := range []string{"armv5", "armv7", "mipsle-softfloat", "riscv64"} {
		BuildArch = arch
		if NewCollector(Config{}, "0.7.1").Host().Arch != arch {
			t.Fatalf("lost release architecture %s", arch)
		}
	}
}

func TestUpdateURLRejectsCredentialExfiltrationAndTraversal(t *testing.T) {
	cfg, _ := NewConfig()
	cfg.Server = "https://monitor.example.com"
	cfg.Group = "test"
	cfg.Bootstrap = true
	client, err := NewClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	valid := "https://monitor.example.com/v1/updates/agent/stable/manifest.json"
	if _, err := client.updateURL(valid, true); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		"https://evil.example/v1/updates/agent/stable/manifest.json", "http://monitor.example.com/v1/updates/agent/stable/manifest.json",
		"https://monitor.example.com:444/v1/updates/agent/stable/manifest.json", "https://name@monitor.example.com/v1/updates/agent/stable/manifest.json",
		valid + "?token=x", valid + "#x", "//monitor.example.com/v1/updates/agent/stable/manifest.json",
		"https://monitor.example.com/v1/updates/../manifest.json", "https://monitor.example.com/v1/updates/%2e%2e/manifest.json",
		"https://monitor.example.com/v1/updates/stable%2f../manifest.json", "https://monitor.example.com/v1/updates/agent/stable/install.ps1",
	} {
		if _, err := client.updateURL(bad, true); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestUpdateChecksWithoutDownloadingAndUsesTLSAccess(t *testing.T) {
	var requests atomic.Int32
	var cfg Config
	var base string
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("X-Monitor-Update-Protocol") != "2" {
			t.Error("update protocol negotiation missing")
		}
		if r.Header.Get("CF-Access-Client-Secret") != cfg.Access.ClientSecret || r.Header.Get("Authorization") != "Bearer "+cfg.DeviceKey || r.Header.Get("X-Monitor-Node-ID") != cfg.NodeID {
			t.Error("missing update credentials")
		}
		if r.URL.Path == "/v1/update/check" {
			_ = json.NewEncoder(w).Encode(UpdateCheck{Enabled: true, Version: "0.4.0", ReleaseTag: "v0.4.0", ManifestURL: base + "/v1/updates/agent/stable/manifest.json"})
			return
		}
		if !strings.HasSuffix(r.URL.Path, "manifest.json") {
			t.Error("check downloaded a binary")
		}
		asset := UpdateAsset{OS: runtime.GOOS, Arch: releaseArch(), File: assetFilename(runtime.GOOS, releaseArch()), Bytes: 1024, SHA256: strings.Repeat("a", 64)}
		asset.URL = base + "/v1/updates/agent/stable/0.4.0/" + asset.SHA256 + "/" + asset.File
		_ = json.NewEncoder(w).Encode(UpdateManifest{Schema: 1, Version: "0.4.0", ReleaseTag: "v0.4.0", Assets: []UpdateAsset{asset}})
	}))
	defer client.Close()
	cfg, base = config, config.Server
	plan, err := client.CheckUpdate(context.Background(), "0.3.0")
	if err != nil || !plan.Available || requests.Load() != 2 {
		t.Fatalf("%+v %v requests=%d", plan, err, requests.Load())
	}
	requests.Store(0)
	plan, err = client.CheckUpdate(context.Background(), "0.4.0")
	if err != nil || plan.Available || requests.Load() != 1 {
		t.Fatalf("current release fetched extra metadata: %+v %v", plan, err)
	}
}

func TestUpdateTracksDeployedRevisionWithoutRepeatedDownloads(t *testing.T) {
	previous := BuildRevision
	BuildRevision = strings.Repeat("a", 40)
	t.Cleanup(func() { BuildRevision = previous })
	for _, row := range []struct {
		name, version, revision, manifestRevision string
		available, invalid                        bool
	}{
		{"same-build", "0.7.1", BuildRevision, BuildRevision, false, false},
		{"new-commit", "0.7.1", strings.Repeat("b", 40), strings.Repeat("b", 40), true, false},
		{"older-version", "0.7.0", strings.Repeat("b", 40), strings.Repeat("b", 40), false, false},
		{"deployment-changed-between-requests", "0.7.1", strings.Repeat("b", 40), strings.Repeat("c", 40), false, true},
		{"invalid-revision", "0.7.1", "bad", "bad", false, true},
	} {
		t.Run(row.name, func(t *testing.T) {
			var requests atomic.Int32
			var origin string
			client, cfg, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.URL.Path == "/v1/update/check" {
					_ = json.NewEncoder(w).Encode(UpdateCheck{Enabled: true, Version: row.version, Revision: row.revision, ReleaseTag: "v" + row.version, ManifestURL: origin + "/v1/updates/agent/stable/manifest.json"})
					return
				}
				asset := UpdateAsset{OS: runtime.GOOS, Arch: releaseArch(), File: assetFilename(runtime.GOOS, releaseArch()), Bytes: 1024, SHA256: strings.Repeat("d", 64)}
				asset.URL = origin + "/v1/updates/agent/stable/" + row.version + "/" + asset.SHA256 + "/" + asset.File
				_ = json.NewEncoder(w).Encode(UpdateManifest{Schema: 1, Version: row.version, Revision: row.manifestRevision, ReleaseTag: "v" + row.version, Assets: []UpdateAsset{asset}})
			}))
			defer client.Close()
			origin = cfg.Server
			plan, err := client.CheckUpdate(context.Background(), "0.7.1")
			if plan.Available != row.available || (err != nil) != row.invalid {
				t.Fatalf("unexpected plan: %+v, error: %v", plan, err)
			}
			if (row.name == "same-build" || row.name == "older-version") && requests.Load() != 1 {
				t.Fatal("unchanged or older deployment fetched unnecessary metadata")
			}
		})
	}
}

func TestUpdateRejectsOversizedMetadataAndRedirectWithoutLeakingSecrets(t *testing.T) {
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { forwarded.Add(1) }))
	defer target.Close()
	for _, scenario := range []string{"redirect", "oversized", "malformed"} {
		t.Run(scenario, func(t *testing.T) {
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch scenario {
				case "redirect":
					http.Redirect(w, r, target.URL, 302)
				case "oversized":
					_, _ = io.WriteString(w, strings.Repeat("x", MaxUpdateManifestBytes+1))
				default:
					_, _ = io.WriteString(w, `{"enabled":true} {}`)
				}
			}))
			defer client.Close()
			_, err := client.CheckUpdate(context.Background(), "0.3.0")
			if err == nil {
				t.Fatal("unsafe metadata accepted")
			}
			if strings.Contains(err.Error(), config.Access.ClientSecret) || strings.Contains(err.Error(), config.DeviceKey) || strings.Contains(err.Error(), config.Server) {
				t.Fatal("error leaked credentials or endpoint")
			}
		})
	}
	if forwarded.Load() != 0 {
		t.Fatal("redirect forwarded credentials")
	}
}

func TestUpdateDownloadStreamsAndRejectsWrongSizeOrDigest(t *testing.T) {
	valid := strings.Repeat("safe-test-binary", 128)
	for _, scenario := range []string{"valid", "wrong-hash", "truncated", "extra", "content-encoding"} {
		t.Run(scenario, func(t *testing.T) {
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				payload := valid
				switch scenario {
				case "wrong-hash":
					payload = strings.Repeat("x", len(valid))
				case "truncated":
					payload = valid[:1024]
				case "extra":
					payload = valid + "x"
				case "content-encoding":
					w.Header().Set("Content-Encoding", "gzip")
				}
				_, _ = io.WriteString(w, payload)
			}))
			defer client.Close()
			hash := fmt.Sprintf("%x", sha256.Sum256([]byte(valid)))
			asset := UpdateAsset{File: "spider-watch-windows-amd64.exe", Bytes: int64(len(valid)), SHA256: hash, URL: config.Server + "/v1/updates/agent/stable/0.4.0/" + hash + "/spider-watch-windows-amd64.exe"}
			file, err := os.CreateTemp(t.TempDir(), "download")
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			err = client.DownloadUpdate(context.Background(), asset, file)
			if (err == nil) != (scenario == "valid") {
				t.Fatalf("unexpected download result: %v", err)
			}
			if scenario == "valid" {
				if err := verifyUpdateFile(file.Name(), asset); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestPublicUpdateDownloadUsesFixedURLWithoutDeviceCredentials(t *testing.T) {
	payload := []byte(strings.Repeat("public-client-build", 128))
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for name := range r.Header {
			if strings.HasPrefix(strings.ToLower(name), "x-monitor-") || strings.HasPrefix(strings.ToLower(name), "cf-access-") || strings.EqualFold(name, "Authorization") {
				t.Errorf("public static download sent device credential header: %s", name)
			}
		}
		_, _ = w.Write(payload)
	}))
	defer client.Close()
	file, err := os.CreateTemp(t.TempDir(), "download")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	asset := UpdateAsset{File: "spider-watch-windows-amd64.exe", Bytes: int64(len(payload)), SHA256: fmt.Sprintf("%x", sha256.Sum256(payload)), URL: config.Server + "/downloads/spider-watch-windows-amd64.exe"}
	if err := client.DownloadUpdate(context.Background(), asset, file); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/downloads/install.sh", "/downloads/other.exe", "/downloads/nested/spider-watch-windows-amd64.exe", "/downloads/spider-watch-windows-amd64.exe?redirect=1"} {
		if _, err := client.updateURL(config.Server+path, false); err == nil {
			t.Fatalf("accepted invalid public asset path %s", path)
		}
	}
}

func TestUpdateRollbackRestoresOldBinaryOnFailedSelfCheckOrServiceStart(t *testing.T) {
	for _, scenario := range []string{"success", "self-check", "service"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			target, staged, backup := filepath.Join(dir, "agent.exe"), filepath.Join(dir, "new.exe"), filepath.Join(dir, "old.exe")
			_ = os.WriteFile(target, []byte("old"), 0600)
			_ = os.WriteFile(staged, []byte("new"), 0600)
			starts, stops := 0, 0
			validate := func() error {
				if scenario == "self-check" {
					return errors.New("invalid image")
				}
				return nil
			}
			activate := func() error {
				starts++
				if scenario == "service" && starts == 1 {
					return errors.New("service start failed")
				}
				return nil
			}
			deactivate := func() error { stops++; return nil }
			err := replaceUpdate(target, staged, backup, validate, activate, deactivate)
			data, _ := os.ReadFile(target)
			if scenario == "success" {
				if err != nil || string(data) != "new" || starts != 1 || stops != 0 {
					t.Fatalf("%s %v %d %d", data, err, starts, stops)
				}
			} else {
				if err == nil || string(data) != "old" || stops != 1 {
					t.Fatalf("rollback: %s %v %d", data, err, stops)
				}
			}
			if _, e := os.Stat(backup); !errors.Is(e, os.ErrNotExist) {
				t.Fatal("backup not consumed or cleaned")
			}
		})
	}
}

func TestUpdateRefusesToOverwriteRecoveryBackup(t *testing.T) {
	dir := t.TempDir()
	target, staged, backup := filepath.Join(dir, "agent.exe"), filepath.Join(dir, "new.exe"), filepath.Join(dir, "old.exe")
	for _, file := range []string{target, staged, backup} {
		_ = os.WriteFile(file, []byte(file), 0600)
	}
	noop := func() error { t.Fatal("called lifecycle hook with unresolved backup"); return nil }
	if replaceUpdate(target, staged, backup, noop, noop, noop) == nil {
		t.Fatal("overwrote recovery backup")
	}
	data, _ := os.ReadFile(backup)
	if string(data) != backup {
		t.Fatal("backup changed")
	}
}

func TestAutomaticUpdateHonorsDisabledPolicyBeforeDownloading(t *testing.T) {
	var requests atomic.Int32
	client, _, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path != "/v1/update/automatic" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("X-Monitor-Node-ID") == "" || r.Header.Get("Authorization") == "" {
			t.Error("missing device credentials")
		}
		_ = json.NewEncoder(w).Encode(UpdateCheck{Enabled: false})
	}))
	defer client.Close()
	plan, err := client.CheckAutomaticUpdate(context.Background(), "0.6.0")
	if err != nil || plan.Available || requests.Load() != 1 {
		t.Fatalf("%+v %v requests=%d", plan, err, requests.Load())
	}
}
