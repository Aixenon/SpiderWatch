package agent

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

func TestSnapshotInterfaceLifecycleAndIndependentResults(t *testing.T) {
	c := &Collector{}
	now := time.Unix(1700000000, 0)
	collect := func(rows []networkCounters) Snapshot {
		now = now.Add(5 * time.Second)
		return c.snapshot(rawMetrics{networks: rows}, now)
	}
	first := collect([]networkCounters{{"a", 100, 200}, {"b", 50, 60}})
	if first.Networks[0].RXPerSec != nil {
		t.Fatal("first counter has a rate")
	}
	second := collect([]networkCounters{{"b", 70, 100}, {"a", 200, 400}})
	if *second.Networks[0].RXPerSec != 4 || *second.Networks[1].TXPerSec != 40 {
		t.Fatal("interface reorder changed deltas")
	}
	third := collect([]networkCounters{{"a", 10, 30}})
	if !third.Networks[0].CounterReset || third.Networks[0].RXPerSec != nil {
		t.Fatal("reset counter produced a rate")
	}
	fourth := collect([]networkCounters{{"b", 90, 200}})
	if fourth.Networks[0].RXPerSec != nil {
		t.Fatal("reappearing interface reused an obsolete baseline")
	}
	collect(nil)
	if s := collect([]networkCounters{{"b", 100, 220}}); s.Networks[0].RXPerSec != nil {
		t.Fatal("failed collection retained a baseline")
	}
	if first.Networks[0].RXBytes != 100 || *second.Networks[1].TXPerSec != 40 {
		t.Fatal("later collection mutated an earlier snapshot")
	}
}

func TestReusableReportEncoderPreservesJSONAndBounds(t *testing.T) {
	var encoder reportEncoder
	for _, value := range []any{benchmarkLiveMetrics(), map[string]any{"name": "磁盘 <>&\u2028", "nil": nil, "invalid": "\xff"}, map[string]string{"long": strings.Repeat("x", MaxRequestBytes-20)}, nil} {
		want, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		got, err := encoder.encode(value)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("wire JSON changed: %v", err)
		}
	}
	if _, err := encoder.encode(strings.Repeat("x", MaxRequestBytes)); err == nil {
		t.Fatal("oversized report accepted")
	}
	if _, err := encoder.encode(math.NaN()); err == nil {
		t.Fatal("non-finite value accepted")
	}
	if got, err := encoder.encode("next"); err != nil || string(got) != `"next"` {
		t.Fatal("encoder did not recover after invalid data")
	}
}
