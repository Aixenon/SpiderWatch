package agent

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Measures both envelopes around the SAME real local metrics sample, using the
// exact production gzip encoder. Logs are bounded and contain no credentials.
func TestWireSizeLiveV2(t *testing.T) {
	c := validTestConfig(t)
	collector := NewCollector(c, "0.4.0")
	collector.Collect(time.Now())
	sample := collector.Collect(time.Now().Add(time.Second))
	old, err := json.Marshal(ReportRequest{Protocol: 1, NodeID: c.NodeID, Session: strings.Repeat("a", 32), Sequence: 2, Host: collector.Host(), Metrics: sample})
	if err != nil {
		t.Fatal(err)
	}
	compact, err := json.Marshal(LiveMetrics{Type: "metrics", Sequence: 2, Metrics: sample})
	if err != nil {
		t.Fatal(err)
	}
	var legacyCompressor, compactCompressor reportCompressor
	compressedOld, _, err := legacyCompressor.encode(old)
	if err != nil {
		t.Fatal(err)
	}
	compressedNew, _, err := compactCompressor.encode(compact)
	if err != nil {
		t.Fatal(err)
	}
	if len(compact) >= len(old) || len(compressedNew) >= len(compressedOld) {
		t.Fatal("compact envelope did not reduce actual wire bytes")
	}
	t.Logf("same Windows sample: V1 JSON=%d, V2 JSON=%d, V1 gzip=%d, V2 gzip=%d; JSON saving=%.1f%%, gzip saving=%.1f%%", len(old), len(compact), len(compressedOld), len(compressedNew), 100*(1-float64(len(compact))/float64(len(old))), 100*(1-float64(len(compressedNew))/float64(len(compressedOld))))
}
