package agent

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"math/rand/v2"
	"strings"
	"time"
)

var ErrRevoked = errors.New("device revoked; stop service and re-enroll with administrator approval")

type RunOptions struct {
	ConfigPath string
	Version    string
	Once       bool
	Logger     *log.Logger
}

// Run has no history queue, metrics HTTP listener, periodic file writes or
// update polling. A panel request may trigger one short installed update bridge.
func Run(ctx context.Context, config Config, options RunOptions) error {
	if err := CheckStartupMemory(); err != nil {
		return err
	}
	client, err := NewClient(config)
	if err != nil {
		return err
	}
	defer client.Close()
	client.configPath = options.ConfigPath
	logger := options.Logger
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	collector := NewCollector(config, options.Version)
	collector.Collect(time.Now()) // Baseline counters; never block CPU sampling.
	var sessionBytes [16]byte
	if _, err = cryptorand.Read(sessionBytes[:]); err != nil {
		return err
	}
	session := hex.EncodeToString(sessionBytes[:])
	state, sequence, failures := "pending", uint64(0), 0
	client.liveHealthy = func() {
		if failures > 0 {
			logger.Print("connection recovered")
		}
		failures = 0
	}
	interval := time.Duration(config.Interval) * time.Second
	liveTransport := false
	guardContext, cancel := context.WithCancel(ctx)
	defer cancel()
	budgetError := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-guardContext.Done():
				return
			case <-ticker.C:
				if err := CheckMemoryBudget(); err != nil {
					budgetError <- err
					cancel()
					return
				}
			}
		}
	}()
	for {
		if err := CheckMemoryBudget(); err != nil {
			return err
		}
		started := time.Now()
		var response ControlResponse
		if state != "approved" {
			if config.Bootstrap && config.Access.ClientID == "" {
				response, err = client.BootstrapStatus(guardContext)
			} else {
				response, err = client.Status(guardContext)
			}
			if err == nil && response.State == "approved" && config.Bootstrap && config.Access.ClientID == "" && config.IdentityMode != "ed25519" {
				if response.Access != nil {
					next := config
					next.Access = *response.Access
					if next.Access.ClientID == "" || next.Access.ClientSecret == "" || next.Validate() != nil {
						return errors.New("invalid bootstrap credentials")
					}
					if options.ConfigPath != "" {
						if err = SaveConfig(options.ConfigPath, next); err != nil {
							return errors.New("could not save Access credentials")
						}
					}
					config, client.config = next, next
				} else if strings.HasPrefix(config.Server, "https://") {
					return errors.New("approved device has no Access credentials")
				}
			}
		} else if liveTransport {
			err = client.Live(guardContext, collector, session, &sequence, options.Once)
			response = ControlResponse{State: "approved", Transport: "websocket"}
			if errors.Is(err, ErrRevoked) {
				return err
			}
			if options.Once && err == nil {
				return nil
			}
		} else {
			sequence++
			response, err = client.Report(guardContext, ReportRequest{
				Protocol: ProtocolVersion, NodeID: config.NodeID, Session: session,
				Sequence: sequence, Host: collector.Host(), Metrics: collector.Collect(started),
			})
		}
		if guardContext.Err() != nil {
			select {
			case budget := <-budgetError:
				return budget
			default:
				return ctx.Err()
			}
		}
		if err != nil {
			var serverError *HTTPError
			if errors.As(err, &serverError) {
				if serverError.Code == "revoked" {
					return ErrRevoked
				}
				if serverError.Code == "pending" {
					state = "pending"
				}
			}
			failures++
			// Log the transition and powers of two, not every failed request.
			if failures == 1 || failures&(failures-1) == 0 {
				logger.Printf("request failed (consecutive=%d)", failures)
			}
		} else {
			if response.State == "revoked" {
				return ErrRevoked
			}
			if failures > 0 {
				logger.Print("connection recovered")
				failures = 0
			}
			if state != response.State {
				state = response.State
				logger.Printf("device state=%s", state)
			}
			liveTransport = response.Transport == "websocket"
			if response.Interval >= 15 && response.Interval <= 3600 && response.Interval > config.Timeout {
				interval = time.Duration(response.Interval) * time.Second
			}
		}
		if budget := CheckMemoryBudget(); budget != nil {
			return budget
		}
		if err == nil && response.State == "approved" && sequence == 0 {
			continue
		}
		if options.Once {
			return err
		}
		delay := retryDelay(interval, failures)
		if failures > 0 && (liveTransport || state != "approved") {
			delay = liveRetryDelay(failures, errors.Is(err, errLiveSuperseded))
		}
		if failures == 0 {
			delay -= time.Since(started)
			if delay < time.Second {
				delay = time.Second
			}
		}
		timer := time.NewTimer(delay)
		select {
		case <-guardContext.Done():
			timer.Stop()
			select {
			case budget := <-budgetError:
				return budget
			default:
				return ctx.Err()
			}
		case <-timer.C:
		}
	}
}

// A working session resets this sequence after an acknowledged report. A
// duplicated identity backs off immediately, avoiding clients evicting each
// other every few seconds. Outages eventually need at most one dial per minute.
func liveRetryDelay(failures int, superseded bool) time.Duration {
	delays := [...]time.Duration{2, 5, 10, 30, 60}
	index := failures - 1
	if index < 0 {
		index = 0
	}
	if index >= len(delays) || superseded {
		index = len(delays) - 1
	}
	delay := delays[index] * time.Second
	return delay + time.Duration(rand.Int64N(int64(delay/10)+1))
}

func retryDelay(interval time.Duration, failures int) time.Duration {
	if failures == 0 {
		return interval
	}
	if interval > 300*time.Second {
		interval = 300 * time.Second
	}
	for i := 1; i < failures && i < 6; i++ {
		interval *= 2
		if interval >= 300*time.Second {
			interval = 300 * time.Second
			break
		}
	}
	return interval + time.Duration(rand.Int64N(int64(interval/10)+1))
}
