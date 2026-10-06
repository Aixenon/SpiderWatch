package agent

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestStartupAvailableMemoryBoundary(t *testing.T) {
	if !errors.Is(checkAvailableMemory(MinimumAvailableBytes-1), ErrInsufficientMemory) {
		t.Fatal("low available RAM accepted")
	}
	for _, value := range []uint64{MinimumAvailableBytes, MinimumAvailableBytes + 1} {
		if err := checkAvailableMemory(value); err != nil {
			t.Fatal(err)
		}
	}
	if value, err := AvailableMemory(); err != nil || value == 0 {
		t.Fatalf("native available memory: %d %v", value, err)
	}
}

func TestReportCompressionBoundsAndRoundTrip(t *testing.T) {
	var compressor reportCompressor
	for _, input := range [][]byte{[]byte("small control"), []byte(strings.Repeat(`{"cpu_percent":12,"memory":16777216}`, 50))} {
		output, compressed, err := compressor.encode(input)
		if err != nil {
			t.Fatal(err)
		}
		if !compressed {
			if !bytes.Equal(input, output) {
				t.Fatal("plain frame changed")
			}
			continue
		}
		reader, err := gzip.NewReader(bytes.NewReader(output))
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := io.ReadAll(reader)
		reader.Close()
		if err != nil || !bytes.Equal(input, decoded) {
			t.Fatal("compression changed report")
		}
	}
	random := make([]byte, 2048)
	_, _ = rand.Read(random)
	if output, compressed, err := compressor.encode(random); err != nil || compressed || !bytes.Equal(output, random) {
		t.Fatal("incompressible frame expanded")
	}
	if _, _, err := compressor.encode(make([]byte, MaxRequestBytes+1)); err == nil {
		t.Fatal("oversized report accepted")
	}
}

func BenchmarkReportCompression(b *testing.B) {
	config, _ := NewConfig()
	collector := NewCollector(config, "0.3.0")
	report := ReportRequest{Protocol: 1, NodeID: config.NodeID, Session: strings.Repeat("f", 32), Sequence: 42, Host: collector.Host(), Metrics: collector.Collect(time.Now())}
	data, _ := json.Marshal(report)
	var compressor reportCompressor
	output, _, err := compressor.encode(data)
	if err != nil {
		b.Fatal(err)
	}
	size := len(output)
	b.ReportAllocs()
	b.SetBytes(int64(len(data)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := compressor.encode(data); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportMetric(float64(len(data)), "raw_bytes")
	b.ReportMetric(float64(size), "gzip_bytes")
}
