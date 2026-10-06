package agent

import (
	"testing"
	"time"
)

func BenchmarkCollector(b *testing.B) {
	c, err := NewConfig()
	if err != nil {
		b.Fatal(err)
	}
	collector := NewCollector(c, "benchmark")
	collector.Collect(time.Now())
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		collector.Collect(time.Now())
	}
}
