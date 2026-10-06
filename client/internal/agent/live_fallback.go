package agent

import (
	"context"
	"errors"
	"log"
	"math/rand/v2"
	"net/http"
	"time"
)

const fallbackAfterFailures = 3
const fallbackReportInterval = time.Minute

func fallbackInterval(seconds int, previous time.Duration) time.Duration {
	if seconds < 20 || seconds > 86400 {
		return previous
	}
	return time.Duration(seconds) * time.Second
}

type fallbackTiming struct {
	report   time.Duration
	retry    func(int, bool) time.Duration
	interval func(int, time.Duration) time.Duration
}

func defaultFallbackTiming() fallbackTiming {
	return fallbackTiming{report: fallbackReportInterval, retry: fallbackRetryDelay, interval: fallbackInterval}
}

func fallbackRetryDelay(failures int, fallback bool) time.Duration {
	if !fallback {
		return liveRetryDelay(failures, false)
	}
	delays := [...]time.Duration{2, 5, 10, 30, 60, 120, 300}
	index := failures - 1
	if index < 0 {
		index = 0
	}
	if index >= len(delays) {
		index = len(delays) - 1
	}
	delay := delays[index] * time.Second
	if delay == 300*time.Second {
		return 270*time.Second + time.Duration(rand.Int64N(int64(30*time.Second)+1))
	}
	return delay + time.Duration(rand.Int64N(int64(delay/10)+1))
}

type fallbackLiveEvent struct {
	interval int
	ready    chan struct{}
	healthy  bool
	done     bool
	err      error
}

type fallbackReportResult struct {
	control ControlResponse
	err     error
	started time.Time
}

func authenticationFailure(err error) bool {
	var rejected *HTTPError
	return errors.As(err, &rejected) && (rejected.Status == http.StatusUnauthorized || rejected.Status == http.StatusForbidden)
}

// Only the coordinator collects for HTTPS, and only after the WebSocket has
// stopped or before its first valid config. The ready handshake cancels and
// joins an in-flight HTTPS request before letting Live collect its first sample.
// This preserves one collector, one sequence and no upload queue without locks
// around potentially expensive system calls or network operations.
func (c *Client) liveWithFallback(ctx context.Context, collector *Collector, session string, sequence *uint64, once bool, logger *log.Logger, timing fallbackTiming) error {
	if once {
		return c.Live(ctx, collector, session, sequence, true)
	}
	ctx, cancel := context.WithCancel(ctx)
	events := make(chan fallbackLiveEvent, 4)
	previousReady, previousHealthy, previousConfig := c.liveReady, c.liveHealthy, c.liveConfig
	c.liveConfig = func(seconds int) { events <- fallbackLiveEvent{interval: max(20, seconds)} }
	c.liveReady = func(readyCtx context.Context) error {
		resume := make(chan struct{})
		select {
		case events <- fallbackLiveEvent{ready: resume}:
		case <-readyCtx.Done():
			return readyCtx.Err()
		}
		select {
		case <-resume:
			return nil
		case <-readyCtx.Done():
			return readyCtx.Err()
		}
	}
	c.liveHealthy = func() { events <- fallbackLiveEvent{healthy: true} }
	var reportDone chan fallbackReportResult
	var reportCancel context.CancelFunc
	var updateDone chan struct{}
	var pendingReady chan struct{}
	wsRunning, liveActive, fallback := false, false, false
	failures, reportFailures := 0, 0
	reportInterval := timing.report
	resolveInterval := timing.interval
	if resolveInterval == nil {
		resolveInterval = func(int, time.Duration) time.Duration { return timing.report }
	}
	var nextReport time.Time
	retryTimer := time.NewTimer(0)
	reportTimer := time.NewTimer(time.Hour)
	reportTimer.Stop()
	var reportTick <-chan time.Time
	defer func() {
		cancel()
		retryTimer.Stop()
		reportTimer.Stop()
		if reportCancel != nil {
			reportCancel()
		}
		if reportDone != nil {
			<-reportDone
		}
		if wsRunning {
			for event := range events {
				if event.done {
					break
				}
			}
		}
		if updateDone != nil {
			<-updateDone
		}
		c.liveReady, c.liveHealthy, c.liveConfig = previousReady, previousHealthy, previousConfig
	}()
	stopReports := func() {
		reportTimer.Stop()
		reportTick = nil
	}
	scheduleReport := func() {
		if fallback && !liveActive && reportDone == nil {
			delay := time.Until(nextReport)
			if delay < 0 {
				delay = 0
			}
			reportTimer.Reset(delay)
			reportTick = reportTimer.C
		}
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-retryTimer.C:
			wsRunning = true
			go func() {
				err := c.Live(ctx, collector, session, sequence, false)
				// Ready, health and completion share one FIFO, so an acknowledged
				// connection resets failures before its later disconnect is counted.
				events <- fallbackLiveEvent{done: true, err: err}
			}()
		case event := <-events:
			if event.interval > 0 {
				reportInterval = resolveInterval(event.interval, reportInterval)
				if previousConfig != nil {
					previousConfig(event.interval)
				}
				continue
			}
			if event.ready != nil {
				liveActive = true
				stopReports()
				pendingReady = event.ready
				if reportCancel != nil {
					reportCancel()
				} else {
					close(pendingReady)
					pendingReady = nil
				}
				continue
			}
			if event.healthy {
				if failures > 0 {
					logger.Print("WebSocket connection recovered")
				}
				failures, reportFailures, fallback = 0, 0, false
				if previousHealthy != nil {
					previousHealthy()
				}
				continue
			}
			if !event.done {
				continue
			}
			wsRunning, liveActive = false, false
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(event.err, ErrRevoked) || authenticationFailure(event.err) || errors.Is(event.err, errLiveSuperseded) {
				return event.err
			}
			failures++
			if failures == 1 || failures&(failures-1) == 0 {
				detail := "connection or protocol error"
				var safe *liveConnectionFailure
				if errors.As(event.err, &safe) {
					detail = safe.Error()
				}
				logger.Printf("WebSocket connection failed (consecutive=%d): %s", failures, detail)
			}
			if failures >= fallbackAfterFailures && !fallback {
				fallback = true
				logger.Print("WebSocket unavailable; using HTTPS with the panel reporting interval while reconnecting")
			}
			scheduleReport()
			retryTimer.Reset(timing.retry(failures, fallback))
		case <-reportTick:
			stopReports()
			// Keep one outstanding report and schedule from its start time, so
			// failures or reconnect attempts cannot cause a burst of uploads.
			now := time.Now()
			*sequence++
			report := ReportRequest{Protocol: ProtocolVersion, NodeID: c.config.NodeID, Session: session,
				Sequence: *sequence, Host: collector.Host(), Metrics: collector.Collect(now), UpdateControl: 1}
			reportCtx, stop := context.WithCancel(ctx)
			reportCancel = stop
			reportDone = make(chan fallbackReportResult, 1)
			go func(done chan<- fallbackReportResult) {
				started := time.Now()
				control, err := c.Report(reportCtx, report)
				done <- fallbackReportResult{control: control, err: err, started: started}
			}(reportDone)
		case result := <-reportDone:
			var rejected *HTTPError
			if result.err == nil || errors.As(result.err, &rejected) && rejected.Status == http.StatusTooManyRequests {
				reportInterval = resolveInterval(result.control.Interval, reportInterval)
			}
			nextReport = result.started.Add(reportInterval)
			reportCancel()
			reportCancel, reportDone = nil, nil
			if result.control.State == "revoked" || result.control.Code == "revoked" || errors.Is(result.err, ErrRevoked) {
				return ErrRevoked
			}
			if authenticationFailure(result.err) {
				return result.err
			}
			if result.err == nil && result.control.State == "pending" {
				return &HTTPError{Status: http.StatusForbidden, Code: "pending"}
			}
			if result.err != nil && !errors.Is(result.err, context.Canceled) {
				reportFailures++
				if reportFailures == 1 || reportFailures&(reportFailures-1) == 0 {
					logger.Printf("HTTPS fallback report failed (consecutive=%d)", reportFailures)
				}
			} else if result.err == nil {
				reportFailures = 0
				if validUpdateRequestID(result.control.UpdateRequestID) && updateDone == nil {
					updateDone = make(chan struct{}, 1)
					go func(id string, done chan<- struct{}) {
						c.fallbackUpdate(ctx, id)
						done <- struct{}{}
					}(result.control.UpdateRequestID, updateDone)
				}
			}
			if pendingReady != nil {
				close(pendingReady)
				pendingReady = nil
			}
			scheduleReport()
		case <-updateDone:
			updateDone = nil
		}
	}
}

func (c *Client) fallbackUpdate(ctx context.Context, id string) {
	ack, found := c.remoteUpdates.find(id)
	if !found {
		triggerCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		ack = c.remoteUpdates.start(triggerCtx, c.configPath, id)
		cancel()
	}
	if ack.State == "failed" && ctx.Err() == nil {
		_ = c.requestedUpdateJSON(ctx, http.MethodPost, "/v1/update/result", requestedUpdateResultMessage{
			RequestID: id, State: "failed", Code: "update_trigger_failed",
		}, nil)
	}
}
