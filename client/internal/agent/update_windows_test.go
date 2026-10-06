//go:build windows

package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// This opt-in integration check compiles isolated executables under t.TempDir,
// then exercises the REAL parent-exit/helper install and rollback flow over TLS.
// It never registers, stops, or creates a Windows service on the development PC.
func TestWindowsUpdateHelperEndToEnd(t *testing.T) {
	if os.Getenv("CF_MONITOR_UPDATE_E2E") != "1" {
		t.Skip("set CF_MONITOR_UPDATE_E2E=1 for compiled updater integration test")
	}
	buildDir := t.TempDir()
	images := map[string]string{}
	for _, version := range []string{"0.3.0", "0.4.0"} {
		image := filepath.Join(buildDir, version+".exe")
		cmd := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go.exe"), "build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w -X main.version="+version, "-o", image, "./cmd/spider-watch")
		cmd.Dir = filepath.Join("..", "..")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build: %v %s", err, output)
		}
		images[version] = image
	}
	for _, scenario := range []string{"install", "rollback"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "spider-watch.exe")
			current, _ := os.Open(images["0.3.0"])
			targetFile, _ := os.Create(target)
			_, _ = io.Copy(targetFile, current)
			current.Close()
			targetFile.Close()
			downloadVersion := "0.4.0"
			if scenario == "rollback" {
				downloadVersion = "0.3.0"
			}
			image, _ := os.Open(images[downloadVersion])
			info, _ := image.Stat()
			h := sha256.New()
			_, _ = io.Copy(h, image)
			image.Close()
			asset := UpdateAsset{OS: "windows", Arch: runtime.GOARCH, File: "spider-watch-windows-" + runtime.GOARCH + ".exe", Bytes: info.Size(), SHA256: hex.EncodeToString(h.Sum(nil))}
			var cfg Config
			var base string
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+cfg.DeviceKey || r.Header.Get("CF-Access-Client-Secret") != cfg.Access.ClientSecret {
					t.Error("missing credentials")
					w.WriteHeader(401)
					return
				}
				switch {
				case r.URL.Path == "/v1/update/check":
					_ = json.NewEncoder(w).Encode(UpdateCheck{Enabled: true, Version: "0.4.0", ReleaseTag: "v0.4.0", ManifestURL: base + "/v1/updates/agent/stable/manifest.json"})
				case strings.HasSuffix(r.URL.Path, "manifest.json"):
					_ = json.NewEncoder(w).Encode(UpdateManifest{Schema: 1, Version: "0.4.0", ReleaseTag: "v0.4.0", Assets: []UpdateAsset{asset}})
				default:
					w.Header().Set("Content-Length", fmt.Sprint(asset.Bytes))
					f, _ := os.Open(images[downloadVersion])
					defer f.Close()
					_, _ = io.Copy(w, f)
				}
			}))
			defer client.Close()
			cfg, base = config, config.Server
			asset.URL = base + "/v1/updates/agent/stable/0.4.0/" + asset.SHA256 + "/" + asset.File
			configPath := filepath.Join(root, "state", "config.json")
			if err := SaveConfig(configPath, cfg); err != nil {
				t.Fatal(err)
			}
			original, _ := os.ReadFile(configPath)
			output, err := exec.Command(target, "--update", "--config", configPath).CombinedOutput()
			if err != nil {
				t.Fatalf("schedule: %v %s", err, output)
			}
			var scheduled map[string]any
			if json.Unmarshal(output, &scheduled) != nil || scheduled["state"] != "installing" {
				t.Fatalf("not scheduled: %s", output)
			}
			deadline := time.Now().Add(20 * time.Second)
			var result updateResult
			for time.Now().Before(deadline) {
				b, e := os.ReadFile(filepath.Join(root, "update-result.json"))
				if e == nil && json.Unmarshal(b, &result) == nil && result.State != "installing" {
					break
				}
				time.Sleep(50 * time.Millisecond)
			}
			wantState, wantVersion := "installed", "0.4.0"
			if scenario == "rollback" {
				wantState, wantVersion = "failed", "0.3.0"
			}
			if result.State != wantState {
				t.Fatalf("helper result: %+v", result)
			}
			versionOutput, err := exec.Command(target, "version").CombinedOutput()
			if err != nil || strings.TrimSpace(string(versionOutput)) != "spider-watch "+wantVersion {
				t.Fatalf("version: %v %s", err, versionOutput)
			}
			after, _ := os.ReadFile(configPath)
			if string(after) != string(original) {
				t.Fatal("identity or Access config changed")
			}
			var installedBytes int64
			_ = filepath.Walk(root, func(_ string, info os.FileInfo, e error) error {
				if e == nil && info.Mode().IsRegular() {
					installedBytes += info.Size()
				}
				return e
			})
			if installedBytes > 64*MiB {
				t.Fatalf("update exceeds disk budget: %d", installedBytes)
			}
			t.Logf("%s: %s, installed bytes=%d, identity retained", scenario, result.State, installedBytes)
		})
	}
}

func TestWindowsUpdateRejectsWrongArchitectureAndNonExecutable(t *testing.T) {
	file := filepath.Join(t.TempDir(), "fake.exe")
	_ = os.WriteFile(file, []byte(strings.Repeat("x", 128)), 0600)
	if validateWindowsImage(file, runtime.GOARCH) == nil {
		t.Fatal("accepted non-PE executable")
	}
	exe, _ := os.Executable()
	wrong := "arm64"
	if runtime.GOARCH == "arm64" {
		wrong = "amd64"
	}
	if validateWindowsImage(exe, wrong) == nil {
		t.Fatal("accepted incompatible architecture")
	}
}

func TestInstalledUpdateSourceRejectsWritableConfigOrCATampering(t *testing.T) {
	t.Setenv("ProgramData", t.TempDir())
	root := filepath.Join(os.Getenv("ProgramData"), "spider-watch")
	if err := os.MkdirAll(filepath.Join(root, "state"), 0700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "service-installed"), []byte("state-v2"), 0600)
	configPath := filepath.Join(root, "state", "config.json")
	_, cfg, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	if err := writeUpdateJSON(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	pin, err := configuredUpdateSource(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = writeUpdateJSON(filepath.Join(root, "update-source.json"), pin); err != nil {
		t.Fatal(err)
	}
	if err := ValidateInstalledUpdateSource(configPath, &cfg); err != nil {
		t.Fatal(err)
	}
	changed := cfg
	changed.Server = "https://attacker.invalid"
	if ValidateInstalledUpdateSource(configPath, &changed) == nil {
		t.Fatal("trusted writable config's changed update server")
	}
	if !isInstalledConfig(strings.ToLower(configPath)) || ValidateInstalledUpdateSource(strings.ToLower(configPath), &changed) == nil {
		t.Fatal("Windows path case variant bypassed administrator source")
	}
	alias := filepath.Join(t.TempDir(), "alias.json")
	if err := os.Link(configPath, alias); err != nil {
		t.Fatal(err)
	}
	if !isInstalledConfig(alias) || ValidateInstalledUpdateSource(alias, &changed) == nil {
		t.Fatal("hard-link alias bypassed canonical administrator source")
	}
	changed = cfg
	changed.AllowLocalHTTP = !cfg.AllowLocalHTTP
	if ValidateInstalledUpdateSource(configPath, &changed) == nil {
		t.Fatal("trusted changed development trust mode")
	}
	if err := os.WriteFile(cfg.CAFile, []byte("modified CA"), 0600); err != nil {
		t.Fatal(err)
	}
	if ValidateInstalledUpdateSource(configPath, &cfg) == nil {
		t.Fatal("trusted modified custom CA")
	}
	// The in-memory hash also protects the read between validation and TLS setup.
	if _, err := NewClient(cfg); err == nil || !strings.Contains(err.Error(), "CA changed") {
		t.Fatalf("TLS read did not recheck pinned digest: %v", err)
	}
}

func TestWindowsUpdaterSetsTrustedOwnerOrFailsClosed(t *testing.T) {
	file := filepath.Join(t.TempDir(), "protected.exe")
	if err := os.WriteFile(file, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := protectUpdatePath(file, false, true); err != nil {
		if !strings.Contains(err.Error(), "Administrator") {
			t.Fatal(err)
		}
		t.Log("Token cannot set Administrators ownership; updater fails closed before helper execution")
		return
	}
	name, _ := syscall.UTF16PtrFromString(file)
	var size uint32
	advapi32.NewProc("GetFileSecurityW").Call(uintptr(unsafe.Pointer(name)), 1, 0, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 || size > 64<<10 {
		t.Fatal("invalid security descriptor size")
	}
	descriptor := make([]byte, size)
	if ok, _, _ := advapi32.NewProc("GetFileSecurityW").Call(uintptr(unsafe.Pointer(name)), 1, uintptr(unsafe.Pointer(&descriptor[0])), uintptr(size), uintptr(unsafe.Pointer(&size))); ok == 0 {
		t.Fatal("cannot read protected owner")
	}
	var owner uintptr
	var inherited uint32
	if ok, _, _ := advapi32.NewProc("GetSecurityDescriptorOwner").Call(uintptr(unsafe.Pointer(&descriptor[0])), uintptr(unsafe.Pointer(&owner)), uintptr(unsafe.Pointer(&inherited))); ok == 0 {
		t.Fatal("cannot read owner SID")
	}
	expected, err := syscall.StringToSid("S-1-5-32-544")
	if err != nil {
		t.Fatal(err)
	}
	if same, _, _ := advapi32.NewProc("EqualSid").Call(owner, uintptr(unsafe.Pointer(expected))); same == 0 {
		t.Fatal("protected file not owned by Administrators")
	}
	t.Log("native Windows ACL owner verified as Administrators")
}
