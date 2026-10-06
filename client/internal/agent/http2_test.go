package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Exercise TLS negotiation, then switch the same client's transport to a
// WebSocket upgrade. This catches accidental sharing of h2 ALPN settings.
func TestHTTP2AndHTTP1FallbackWithWebSocket(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		name, major := "http1", 1
		if h2 {
			name, major = "http2", 2
		}
		t.Run(name, func(t *testing.T) {
			payload := strings.Repeat("binary-fixture", 128)
			var requests, reports atomic.Int32
			client, cfg, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/live" {
					if r.ProtoMajor != 1 || r.TLS.NegotiatedProtocol != "http/1.1" {
						t.Errorf("WebSocket upgrade: HTTP/%d ALPN=%q", r.ProtoMajor, r.TLS.NegotiatedProtocol)
					}
					conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
					if err != nil {
						t.Error(err)
						return
					}
					defer conn.Close()
					_ = conn.WriteJSON(liveTestConfig(30, 1))
					var report ReportRequest
					if err = conn.ReadJSON(&report); err != nil {
						t.Error(err)
						return
					}
					reports.Add(1)
					_ = conn.WriteJSON(liveControl{Type: "ack", Sequence: report.Sequence})
					return
				}
				requests.Add(1)
				if r.ProtoMajor != major {
					t.Errorf("negotiated HTTP/%d, want HTTP/%d", r.ProtoMajor, major)
				}
				switch {
				case strings.HasSuffix(r.URL.Path, "/status"):
					_ = json.NewEncoder(w).Encode(ControlResponse{State: "approved"})
				case r.URL.Path == "/v1/update/check":
					_ = json.NewEncoder(w).Encode(UpdateCheck{Enabled: false})
				default:
					_, _ = io.WriteString(w, payload)
				}
			}), h2)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if _, err := client.Status(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := client.CheckUpdate(ctx, "0.7.0"); err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256([]byte(payload))
			digest := hex.EncodeToString(hash[:])
			file, err := os.CreateTemp(t.TempDir(), "download")
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			asset := UpdateAsset{Bytes: int64(len(payload)), SHA256: digest,
				URL: cfg.Server + "/v1/updates/stable/0.7.0/" + digest + "/spider-watch-windows-amd64.exe"}
			if err = client.DownloadUpdate(ctx, asset, file); err != nil {
				t.Fatal(err)
			}
			var sequence uint64
			if err = client.Live(ctx, NewCollector(cfg, "0.7.0"), strings.Repeat("a", 32), &sequence, true); err != nil {
				t.Fatal(err)
			}
			if requests.Load() != 3 || reports.Load() != 1 {
				t.Fatal("missing control request, update download, or acknowledged report")
			}
		})
	}
}
