package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRequestedUpdateClaimsAndReportsBeforeInstalling(t *testing.T) {
	previous := BuildRevision
	BuildRevision = strings.Repeat("a", 40)
	t.Cleanup(func() { BuildRevision = previous })
	for _, scenario := range []string{"update", "same-version-new-revision", "up-to-date", "claim-conflict", "update-conflict", "deploy-changed", "disabled", "download-failed", "low-memory", "downgrade"} {
		t.Run(scenario, func(t *testing.T) {
			var mu sync.Mutex
			var operations []string
			record := func(s string) { mu.Lock(); operations = append(operations, s); mu.Unlock() }
			job := requestedUpdate{RequestID: strings.Repeat("b", 32), Version: "0.7.2", Revision: strings.Repeat("c", 40), ExpiresAt: time.Now().Add(10 * time.Minute).UnixMilli()}
			current := "0.7.1"
			if scenario == "same-version-new-revision" {
				current = job.Version
			}
			if scenario == "up-to-date" {
				current, job.Revision = job.Version, BuildRevision
			}
			if scenario == "downgrade" {
				current = "1.0.0"
			}
			var origin string
			var config Config
			client, cfg, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				key, _ := config.identityPrivateKey()
				digest := sha256.Sum256(body)
				payload := strings.Join([]string{"cf-monitor-auth-v1", r.Method, origin, r.URL.Path, config.NodeID, r.Header.Get("X-Monitor-Time"), r.Header.Get("X-Monitor-Nonce"), hex.EncodeToString(digest[:])}, "\n")
				signature, _ := base64.StdEncoding.DecodeString(r.Header.Get("X-Monitor-Signature"))
				if !ed25519.Verify(key.Public().(ed25519.PublicKey), []byte(payload), signature) {
					t.Error("missing or incorrect update signature/body binding")
				}
				switch r.URL.Path {
				case "/v1/update/request":
					record("request")
					_ = json.NewEncoder(w).Encode(job)
				case "/v1/update/result":
					var status requestedUpdateResultMessage
					if decodeOne(body, &status) != nil || status.RequestID != job.RequestID {
						t.Error("invalid job result")
					}
					record(status.State)
					if (status.State == "failed") != (status.Code == "update_failed") {
						t.Error("incorrect error detail")
					}
					if scenario == "claim-conflict" && status.State == "accepted" || scenario == "update-conflict" && status.State == "updating" {
						w.WriteHeader(409)
						return
					}
					w.WriteHeader(204)
				case "/v1/update/check":
					record("check")
					revision := job.Revision
					if scenario == "deploy-changed" {
						revision = strings.Repeat("d", 40)
					}
					_ = json.NewEncoder(w).Encode(UpdateCheck{Enabled: scenario != "disabled", Version: job.Version, Revision: revision, ReleaseTag: "v" + job.Version, ManifestURL: origin + "/v1/updates/stable/manifest.json"})
				case "/v1/updates/stable/manifest.json":
					record("manifest")
					revision := job.Revision
					if scenario == "deploy-changed" {
						revision = strings.Repeat("d", 40)
					}
					file := assetFilename(runtime.GOOS, releaseArch())
					_ = json.NewEncoder(w).Encode(UpdateManifest{Schema: 1, Version: job.Version, Revision: revision, ReleaseTag: "v" + job.Version, Assets: []UpdateAsset{{OS: runtime.GOOS, Arch: releaseArch(), File: file, Bytes: 1024, SHA256: strings.Repeat("e", 64), URL: origin + "/downloads/" + file}}})
				default:
					t.Error("unexpected endpoint or automatic-policy lookup: " + r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			cfg.IdentityMode = "ed25519"
			client.config = cfg
			config, origin = cfg, cfg.Server
			result, err := client.performRequestedUpdate(context.Background(), current, "installed-config", func(_ context.Context, plan UpdatePlan, configPath string) (string, error) {
				record("schedule")
				if configPath != "installed-config" || plan.Version != job.Version || plan.Revision != job.Revision {
					t.Error("changed update target")
				}
				if scenario == "download-failed" {
					return "", errors.New("download failed")
				}
				return "update-result.json", nil
			}, func() error {
				if scenario == "low-memory" {
					return ErrInsufficientMemory
				}
				return nil
			})
			mu.Lock()
			order := strings.Join(operations, ",")
			mu.Unlock()
			want := "request,accepted,check,manifest,updating,schedule"
			wantState, wantError := "updating", false
			switch scenario {
			case "claim-conflict":
				want, wantState = "request,accepted", "idle"
			case "update-conflict":
				want, wantState = "request,accepted,check,manifest,updating", "idle"
			case "up-to-date":
				want, wantState = "request,accepted,check,up_to_date", "up_to_date"
			case "disabled", "downgrade":
				want, wantError = "request,accepted,check,failed", true
			case "deploy-changed", "low-memory":
				want, wantError = "request,accepted,check,manifest,failed", true
			case "download-failed":
				want, wantError = want+",failed", true
			}
			if order != want || (err != nil) != wantError || !wantError && result.State != wantState {
				t.Fatalf("order=%s result=%+v error=%v", order, result, err)
			}
		})
	}
}

func TestRequestedUpdateRejectsInvalidJobsBeforeClaim(t *testing.T) {
	valid := requestedUpdate{RequestID: strings.Repeat("a", 32), Version: "0.7.2", Revision: strings.Repeat("b", 40), ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
	for _, scenario := range []string{"none", "upper-id", "bad-id", "bad-version", "bad-revision", "expired", "far-future", "oversized", "extra-field", "empty-with-target", "redirect"} {
		t.Run(scenario, func(t *testing.T) {
			var requests int
			client, _, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.URL.Path != "/v1/update/request" {
					t.Error("invalid job was claimed")
				}
				job := valid
				switch scenario {
				case "none":
					job = requestedUpdate{}
				case "upper-id":
					job.RequestID = strings.Repeat("A", 32)
				case "bad-id":
					job.RequestID = "../command"
				case "bad-version":
					job.Version = "0.7.2-rc1"
				case "bad-revision":
					job.Revision = "main"
				case "expired":
					job.ExpiresAt = time.Now().Add(-time.Minute).UnixMilli()
				case "far-future":
					job.ExpiresAt = time.Now().Add(48 * time.Hour).UnixMilli()
				case "empty-with-target":
					job.RequestID = ""
				case "oversized":
					_, _ = io.WriteString(w, strings.Repeat("x", MaxResponseBytes+1))
					return
				case "extra-field":
					_, _ = io.WriteString(w, `{"request_id":"","command":"bad"}`)
					return
				case "redirect":
					http.Redirect(w, r, "https://untrusted.invalid/", 302)
					return
				}
				_ = json.NewEncoder(w).Encode(job)
			}))
			result, err := client.performRequestedUpdate(context.Background(), "0.7.1", "", func(context.Context, UpdatePlan, string) (string, error) {
				t.Fatal("invalid job installed")
				return "", nil
			}, func() error { return nil })
			if requests != 1 || (err == nil) != (scenario == "none") || scenario == "none" && result.State != "idle" {
				t.Fatalf("requests=%d result=%+v error=%v", requests, result, err)
			}
		})
	}
}
