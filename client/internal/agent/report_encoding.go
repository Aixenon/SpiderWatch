package agent

import (
	"bytes"
	"encoding/json"
	"errors"
)

// Owned by one WebSocket writer. Returned bytes stay valid until the next
// encode; synchronous compression and WriteMessage finish before that call.
type reportEncoder struct {
	buffer  bytes.Buffer
	encoder *json.Encoder
}

func (e *reportEncoder) encode(report any) ([]byte, error) {
	e.buffer.Reset()
	if e.encoder == nil {
		e.encoder = json.NewEncoder(&e.buffer)
	}
	if err := e.encoder.Encode(report); err != nil {
		return nil, err
	}
	// Encoder appends one newline. Keep the existing Marshal wire bytes.
	data := e.buffer.Bytes()
	data = data[:len(data)-1]
	if len(data) > MaxRequestBytes {
		// Many multi-disk volumes can repeat the same optional topology. Keep
		// the original resource metrics flowing within the existing wire cap.
		// Work on a copy so cached topology and the caller's snapshot survive.
		switch value := report.(type) {
		case LiveMetrics:
			if metrics, changed := withoutDiskTopology(value.Metrics); changed {
				value.Metrics = metrics
				return e.encode(value)
			}
		case ReportRequest:
			if metrics, changed := withoutDiskTopology(value.Metrics); changed {
				value.Metrics = metrics
				return e.encode(value)
			}
		}
		return nil, errors.New("WebSocket report exceeds size limit")
	}
	return data, nil
}

func withoutDiskTopology(metrics Snapshot) (Snapshot, bool) {
	for _, disk := range metrics.Disks {
		if len(disk.PhysicalDisks) != 0 {
			metrics.Disks = append([]DiskMetrics(nil), metrics.Disks...)
			for i := range metrics.Disks {
				metrics.Disks[i].PhysicalDisks = nil
			}
			metrics.Unavailable = append(append([]string(nil), metrics.Unavailable...), "disk_topology_size_limit")
			return metrics, true
		}
	}
	return metrics, false
}
