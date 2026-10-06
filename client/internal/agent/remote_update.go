package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

type requestedUpdate struct {
	RequestID string `json:"request_id"`
	Version   string `json:"version,omitempty"`
	Revision  string `json:"revision,omitempty"`
	ExpiresAt int64  `json:"expires_at,omitempty"`
}

type requestedUpdateResultMessage struct {
	RequestID string `json:"request_id"`
	State     string `json:"state"`
	Code      string `json:"code,omitempty"`
}

type RequestedUpdateResult struct {
	State      string `json:"state"`
	Version    string `json:"version,omitempty"`
	ResultFile string `json:"result_file,omitempty"`
}

var errUpdateAlreadyClaimed = errors.New("update request is no longer available")

// Both paths are constants owned by this client. No job can supply a URL,
// command, target path or installation option to the privileged updater.
func (c *Client) requestedUpdateJSON(ctx context.Context, method, endpoint string, body any, target any) error {
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil || len(payload) > MaxResponseBytes {
			return errors.New("invalid update control request")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.config.Server, "/")+endpoint, bytes.NewReader(payload))
	if err != nil {
		return errors.New("invalid update control endpoint")
	}
	if err = c.authorizeRequest(req, payload); err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "spider-watch/update")
	if c.config.Access.ClientID != "" {
		req.Header.Set("CF-Access-Client-Id", c.config.Access.ClientID)
		req.Header.Set("CF-Access-Client-Secret", c.config.Access.ClientSecret)
	}
	response, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("update control network or TLS request failed")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		return errUpdateAlreadyClaimed
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || (response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity") {
		return errors.New("update control request rejected")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes+1))
	if err != nil || len(data) > MaxResponseBytes {
		return errors.New("invalid update control response size")
	}
	if target != nil && decodeOne(data, target) != nil {
		return errors.New("invalid update control response")
	}
	return nil
}

func (c *Client) requestedUpdateResult(ctx context.Context, id, state string) error {
	message := requestedUpdateResultMessage{RequestID: id, State: state}
	if state == "failed" {
		message.Code = "update_failed"
	}
	return c.requestedUpdateJSON(ctx, http.MethodPost, "/v1/update/result", message, nil)
}

// RequestedUpdate is called only after PrepareRequestedUpdate, loading the
// installed configuration and checking its administrator-pinned update source.
func (c *Client) RequestedUpdate(ctx context.Context, current, configPath string) (RequestedUpdateResult, error) {
	return c.performRequestedUpdate(ctx, current, configPath, c.ScheduleUpdate, CheckStartupMemory)
}

func (c *Client) performRequestedUpdate(ctx context.Context, current, configPath string,
	schedule func(context.Context, UpdatePlan, string) (string, error), checkMemory func() error) (result RequestedUpdateResult, resultErr error) {
	result.State = "idle"
	var job requestedUpdate
	if err := c.requestedUpdateJSON(ctx, http.MethodGet, "/v1/update/request", nil, &job); err != nil {
		if errors.Is(err, errUpdateAlreadyClaimed) {
			return result, nil
		}
		return result, err
	}
	if job.RequestID == "" {
		if job.Version != "" || job.Revision != "" || job.ExpiresAt != 0 {
			return result, errors.New("invalid empty update request")
		}
		return result, nil
	}
	now := time.Now().UnixMilli()
	_, prerelease, versionOK := parseReleaseVersion(job.Version)
	if !validUpdateRequestID(job.RequestID) || !versionOK || prerelease || !validBuildRevision(job.Revision) || job.ExpiresAt <= now || job.ExpiresAt > now+int64((24*time.Hour)/time.Millisecond) {
		return result, errors.New("invalid or expired update request")
	}
	if err := c.requestedUpdateResult(ctx, job.RequestID, "accepted"); err != nil {
		if errors.Is(err, errUpdateAlreadyClaimed) {
			return result, nil
		}
		return result, err
	}
	// Best-effort failure reporting is bounded and does not retry or create a
	// background worker. A process killed during installation is reconciled by
	// the server's expiry or the installed client's next authenticated hello.
	defer func() {
		if errors.Is(resultErr, errUpdateAlreadyClaimed) {
			result.State, resultErr = "idle", nil
			return
		}
		if resultErr != nil && !errors.Is(resultErr, errUpdateAlreadyClaimed) {
			failureCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Duration(c.config.Timeout)*time.Second)
			defer cancel()
			_ = c.requestedUpdateResult(failureCtx, job.RequestID, "failed")
		}
	}()
	plan, err := c.CheckUpdate(ctx, current) // A manual request ignores auto_update.
	if err != nil {
		return result, err
	}
	if !plan.Enabled || plan.Version != job.Version || plan.Revision != job.Revision {
		return result, errors.New("requested release no longer matches deployed update")
	}
	result.Version = plan.Version
	if !plan.Available {
		if current != job.Version || BuildRevision != job.Revision {
			return result, errors.New("requested update would downgrade this client")
		}
		if err = c.requestedUpdateResult(ctx, job.RequestID, "up_to_date"); err != nil {
			return result, err
		}
		result.State = "up_to_date"
		return result, nil
	}
	if err = checkMemory(); err != nil {
		return result, err
	}
	if err = c.requestedUpdateResult(ctx, job.RequestID, "updating"); err != nil {
		return result, err
	}
	result.ResultFile, err = schedule(ctx, plan, configPath)
	if err != nil {
		return result, err
	}
	result.State = "updating"
	return result, nil
}
