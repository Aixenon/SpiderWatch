package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func parallelUpdateFixture(t *testing.T, size int) ([]byte, UpdateAsset, *os.File) {
	t.Helper()
	data := make([]byte, size)
	for index := range data {
		data[index] = byte(index*31 ^ index>>13)
	}
	file, err := os.OpenFile(t.TempDir()+"/update", os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { file.Close() })
	return data, UpdateAsset{File: "spider-watch-windows-amd64.exe", Bytes: int64(size), SHA256: fmt.Sprintf("%x", sha256.Sum256(data))}, file
}

func updateFixturePart(t *testing.T, r *http.Request, data []byte, asset UpdateAsset) (int, []byte) {
	t.Helper()
	prefix := "/downloads/parts/" + asset.SHA256 + "/"
	index, err := strconv.Atoi(strings.TrimPrefix(r.URL.Path, prefix))
	if err != nil || index < 0 || index >= updateDownloadWorkers || !strings.HasPrefix(r.URL.Path, prefix) {
		t.Errorf("unexpected part URL: %s", r.URL.Path)
		return -1, nil
	}
	size := (len(data) + updateDownloadWorkers - 1) / updateDownloadWorkers
	start := index * size
	return index, data[start:min(start+size, len(data))]
}

func TestUpdatePartsDownloadConcurrentlyWithHTTP1AndHTTP2(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		t.Run(fmt.Sprintf("http2=%v", h2), func(t *testing.T) {
			data, asset, file := parallelUpdateFixture(t, 1024*1024+3)
			var count, active, peak atomic.Int32
			allStarted := make(chan struct{})
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/update/check" {
					_, _ = io.WriteString(w, `{"enabled":false}`)
					return
				}
				for name := range r.Header {
					if strings.HasPrefix(strings.ToLower(name), "x-monitor-") || strings.HasPrefix(strings.ToLower(name), "cf-access-") || strings.EqualFold(name, "Authorization") || strings.EqualFold(name, "Cookie") || strings.EqualFold(name, "Range") {
						t.Errorf("static part sent an unnecessary or private header: %s", name)
					}
				}
				if r.ProtoMajor != 1+boolInt(h2) {
					t.Errorf("negotiated unexpected HTTP/%d", r.ProtoMajor)
				}
				index, part := updateFixturePart(t, r, data, asset)
				if index < 0 {
					w.WriteHeader(500)
					return
				}
				current := active.Add(1)
				defer active.Add(-1)
				for previous := peak.Load(); current > previous && !peak.CompareAndSwap(previous, current); previous = peak.Load() {
				}
				if count.Add(1) == updateDownloadWorkers {
					close(allStarted)
				}
				select {
				case <-allStarted:
				case <-r.Context().Done():
					return
				}
				w.Header().Set("Content-Length", strconv.Itoa(len(part)))
				_, _ = w.Write(part)
			}), h2)
			asset.URL = config.Server + "/downloads/" + asset.File
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			// Real updates first negotiate HTTP/2 while checking metadata. Clone
			// that already-used transport, not only a pristine test transport.
			if _, err := client.CheckUpdate(ctx, "0.7.1"); err != nil {
				t.Fatal(err)
			}
			if err := client.DownloadUpdate(ctx, asset, file); err != nil {
				t.Fatal(err)
			}
			if count.Load() != 4 || peak.Load() != 4 || client.transport.MaxConnsPerHost != 1 || client.http.Transport != client.transport {
				t.Fatalf("parallelism or resident transport changed: count=%d peak=%d max=%d", count.Load(), peak.Load(), client.transport.MaxConnsPerHost)
			}
			if err := verifyUpdateFile(file.Name(), asset); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func TestMissingUpdatePartsFallBackToOneVerifiedFullFile(t *testing.T) {
	data, asset, file := parallelUpdateFixture(t, parallelUpdateMinimum+3)
	var parts, full atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/downloads/parts/") {
			parts.Add(1)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		full.Add(1)
		_, _ = w.Write(data)
	}))
	asset.URL = config.Server + "/downloads/" + asset.File
	if err := client.DownloadUpdate(context.Background(), asset, file); err != nil {
		t.Fatal(err)
	}
	if parts.Load() < 1 || parts.Load() > 4 || full.Load() != 1 {
		t.Fatalf("unbounded fallback: parts=%d full=%d", parts.Load(), full.Load())
	}
	if err := verifyUpdateFile(file.Name(), asset); err != nil {
		t.Fatal(err)
	}
}

func TestSmallAndLegacyUpdatesDoNotRequestParts(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprintf("legacy=%v", legacy), func(t *testing.T) {
			size := 2048
			if legacy {
				size = parallelUpdateMinimum + 3
			}
			data, asset, file := parallelUpdateFixture(t, size)
			var count atomic.Int32
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				count.Add(1)
				if strings.Contains(r.URL.Path, "/parts/") || r.Header.Get("Range") != "" {
					t.Error("legacy or small download requested parts")
				}
				if legacy && (r.Header.Get("Authorization") == "" || r.Header.Get("CF-Access-Client-Secret") == "") {
					t.Error("legacy authentication was lost")
				}
				_, _ = w.Write(data)
			}))
			asset.URL = config.Server + "/downloads/" + asset.File
			if legacy {
				asset.URL = config.Server + "/v1/updates/agent/stable/0.7.1/" + asset.SHA256 + "/" + asset.File
			}
			if err := client.DownloadUpdate(context.Background(), asset, file); err != nil || count.Load() != 1 {
				t.Fatalf("single download: count=%d error=%v", count.Load(), err)
			}
		})
	}
}

func TestUpdatePartsRejectInvalidResponsesAndNeverAcceptUnverifiedFallback(t *testing.T) {
	for _, scenario := range []string{"partial-status", "content-range", "length", "truncated", "overflow", "encoded", "wrong-hash"} {
		t.Run(scenario, func(t *testing.T) {
			data, asset, file := parallelUpdateFixture(t, parallelUpdateMinimum+3)
			var full atomic.Int32
			client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, "/parts/") {
					full.Add(1)
					// The fallback must also prove its full SHA-256.
					_, _ = w.Write(bytes.Repeat([]byte("x"), len(data)))
					return
				}
				_, part := updateFixturePart(t, r, data, asset)
				switch scenario {
				case "partial-status":
					w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(part)-1, len(data)))
					w.WriteHeader(http.StatusPartialContent)
				case "content-range":
					w.Header().Set("Content-Range", "bytes 0-1/2")
				case "length":
					w.Header().Set("Content-Length", strconv.Itoa(len(part)+1))
				case "truncated":
					w.Header().Set("Content-Length", strconv.Itoa(len(part)))
					part = part[:len(part)-1]
				case "overflow":
					w.(http.Flusher).Flush()
					part = append(append([]byte(nil), part...), 'x')
				case "encoded":
					w.Header().Set("Content-Encoding", "gzip")
				case "wrong-hash":
					part = bytes.Repeat([]byte("x"), len(part))
				}
				_, _ = w.Write(part)
			}))
			asset.URL = config.Server + "/downloads/" + asset.File
			if err := client.DownloadUpdate(context.Background(), asset, file); err == nil {
				t.Fatal("invalid update accepted")
			} else if strings.Contains(err.Error(), config.Server) || strings.Contains(err.Error(), config.DeviceKey) || strings.Contains(err.Error(), config.Access.ClientSecret) {
				t.Fatal("download error leaked endpoint or credentials")
			}
			info, err := file.Stat()
			if err != nil || info.Size() != 0 || full.Load() != 1 {
				t.Fatalf("partial file not cleared or invalid fallback count: info=%v error=%v full=%d", info, err, full.Load())
			}
		})
	}
}

func TestUpdatePartsCancellationStopsEveryRequestWithoutFallback(t *testing.T) {
	data, asset, file := parallelUpdateFixture(t, parallelUpdateMinimum+3)
	var started, full atomic.Int32
	allStarted := make(chan struct{})
	finished := make(chan struct{}, updateDownloadWorkers)
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/parts/") {
			full.Add(1)
			_, _ = w.Write(data)
			return
		}
		defer func() { finished <- struct{}{} }()
		if started.Add(1) == updateDownloadWorkers {
			close(allStarted)
		}
		<-r.Context().Done()
	}))
	asset.URL = config.Server + "/downloads/" + asset.File
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- client.DownloadUpdate(ctx, asset, file) }()
	select {
	case <-allStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("four downloads never started")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("unexpected cancellation result: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("download goroutines did not stop")
	}
	for range updateDownloadWorkers {
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Fatal("canceled HTTP request remained active")
		}
	}
	if info, err := file.Stat(); err != nil || info.Size() != 0 || full.Load() != 0 {
		t.Fatalf("canceled update left a file or retried: info=%v error=%v full=%d", info, err, full.Load())
	}
}

func TestFailedUpdatePartCancelsPeersBeforeVerifiedFallback(t *testing.T) {
	data, asset, file := parallelUpdateFixture(t, parallelUpdateMinimum+3)
	var started, full atomic.Int32
	allStarted := make(chan struct{})
	var peers sync.WaitGroup
	peers.Add(3)
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/parts/") {
			full.Add(1)
			_, _ = w.Write(data)
			return
		}
		index, part := updateFixturePart(t, r, data, asset)
		if index != 0 {
			defer peers.Done()
		}
		if started.Add(1) == updateDownloadWorkers {
			close(allStarted)
		}
		select {
		case <-allStarted:
		case <-r.Context().Done():
			return
		}
		if index == 0 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(part)))
		w.(http.Flusher).Flush()
		_, _ = w.Write(part[:1])
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		// Late server bytes must not reach the cleared fallback destination.
		_, _ = w.Write(part[1:])
	}))
	asset.URL = config.Server + "/downloads/" + asset.File
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.DownloadUpdate(ctx, asset, file); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { peers.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("failed parallel attempt leaked requests")
	}
	if full.Load() != 1 {
		t.Fatal("unexpected fallback count")
	}
	if err := verifyUpdateFile(file.Name(), asset); err != nil {
		t.Fatal("late part corrupted fallback: " + err.Error())
	}
}

func TestUpdatePartsDoNotFollowRedirects(t *testing.T) {
	data, asset, file := parallelUpdateFixture(t, parallelUpdateMinimum)
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { forwarded.Add(1) }))
	defer target.Close()
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/parts/") {
			http.Redirect(w, r, target.URL, http.StatusFound)
			return
		}
		_, _ = w.Write(data)
	}))
	asset.URL = config.Server + "/downloads/" + asset.File
	if err := client.DownloadUpdate(context.Background(), asset, file); err != nil || forwarded.Load() != 0 {
		t.Fatalf("redirect escaped origin or fallback failed: %v forwarded=%d", err, forwarded.Load())
	}
}

func TestUpdateCopyNeverWritesAnOverflowByte(t *testing.T) {
	const length = 32771
	var destination bytes.Buffer
	response := &http.Response{ContentLength: -1, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(strings.Repeat("x", length+1)))}
	if err := copyUpdateResponse(response, &destination, length); err == nil || destination.Len() != length {
		t.Fatalf("overflow was written: length=%d error=%v", destination.Len(), err)
	}
}
