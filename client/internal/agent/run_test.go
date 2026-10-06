package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestApprovedOnceReportsAndFailuresPropagate(t *testing.T) {
	var reports atomic.Int32
	client, config, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/metrics" {
			reports.Add(1)
		}
		_ = json.NewEncoder(w).Encode(ControlResponse{State: "approved"})
	}))
	client.Close()
	if err := Run(context.Background(), config, RunOptions{Once: true}); err != nil {
		t.Fatal(err)
	}
	if reports.Load() != 1 {
		t.Fatal("approved --once did not submit exactly one report")
	}
	bad, badConfig, _ := tlsTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
		_ = json.NewEncoder(w).Encode(ControlResponse{Code: "temporary"})
	}))
	bad.Close()
	if err := Run(context.Background(), badConfig, RunOptions{Once: true}); err == nil {
		t.Fatal("failed request was hidden")
	}
}
