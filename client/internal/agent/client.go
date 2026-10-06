package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	config        Config
	http          *http.Client
	transport     *http.Transport
	websocketTLS  *tls.Config
	configPath    string
	liveHealthy   func()
	liveReady     func(context.Context) error
	liveConfig    func(int)
	remoteUpdates remoteUpdateControl
}

type HTTPError struct {
	Status int
	Code   string
}

func (e *HTTPError) Error() string {
	// Never log a raw response, URL, request body or authentication headers.
	if e.Code == "invitation_invalid_or_expired" || e.Code == "invitation_used" || e.Code == "registration_closed" {
		return "join invitation expired, canceled or already used; copy a new command from the panel"
	}
	return fmt.Sprintf("server rejected request (HTTP %d)", e.Status)
}

func NewClient(c Config) (*Client, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if c.CAFile != "" {
		b, err := ReadBounded(c.CAFile, MaxCABytes)
		if err != nil {
			return nil, fmt.Errorf("read CA: %w", err)
		}
		if c.expectedCAHash != "" {
			digest := sha256.Sum256(b)
			if hex.EncodeToString(digest[:]) != c.expectedCAHash {
				return nil, errors.New("update CA changed after administrator-source verification")
			}
		}
		// Explicit CA mode avoids loading a large system pool on constrained hosts.
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(b) {
			return nil, errors.New("CA file contains no certificates")
		}
		tlsConfig.RootCAs = pool
	}
	timeout := time.Duration(c.Timeout) * time.Second
	t := &http.Transport{
		Proxy:           nil, // Sending fleet credentials through an environment proxy is opt-in future work.
		DialContext:     (&net.Dialer{Timeout: timeout, KeepAlive: 60 * time.Second}).DialContext,
		TLSClientConfig: tlsConfig.Clone(), TLSHandshakeTimeout: timeout,
		ResponseHeaderTimeout: timeout, MaxResponseHeaderBytes: MaxResponseBytes,
		MaxIdleConns: 1, MaxIdleConnsPerHost: 1, MaxConnsPerHost: 1,
		IdleConnTimeout:    2 * time.Duration(c.Interval) * time.Second,
		DisableCompression: true, ForceAttemptHTTP2: true,
		ReadBufferSize: 4096, WriteBufferSize: 4096,
	}
	h := &http.Client{
		Transport: t, Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirects are disabled")
		},
	}
	// Keep WebSocket's HTTP/1.1 upgrade independent of the HTTP transport's
	// ALPN configuration, which net/http may initialize on the first request.
	tlsConfig.NextProtos = []string{"http/1.1"}
	return &Client{config: c, http: h, transport: t, websocketTLS: tlsConfig}, nil
}

func (c *Client) Close() { c.transport.CloseIdleConnections() }

func (c *Client) request(ctx context.Context, method, path string, body any) (ControlResponse, error) {
	var result ControlResponse
	var reader io.Reader
	var encoded []byte
	if body != nil {
		var b []byte
		var err error
		if report, ok := body.(ReportRequest); ok {
			var encoder reportEncoder
			b, err = encoder.encode(report)
		} else {
			b, err = json.Marshal(body)
		}
		if err != nil || len(b) > MaxRequestBytes {
			return result, errors.New("request exceeds size limit")
		}
		reader = bytes.NewReader(b)
		encoded = b
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.config.Server, "/")+path, reader)
	if err != nil {
		return result, errors.New("invalid request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "spider-watch/1")
	if err := c.authorizeRequest(req, encoded); err != nil {
		return result, err
	}
	if strings.HasSuffix(path, "/enroll") && c.config.Invitation != "" {
		req.Header.Set("X-Monitor-Invitation", c.config.Invitation)
	}
	if c.config.Access.ClientID != "" && !strings.HasPrefix(path, "/bootstrap/") {
		req.Header.Set("CF-Access-Client-Id", c.config.Access.ClientID)
		req.Header.Set("CF-Access-Client-Secret", c.config.Access.ClientSecret)
	}
	res, err := c.http.Do(req)
	if err != nil {
		// url.Error contains the full endpoint. Preserve a typed timeout only.
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		return result, errors.New("network or TLS request failed")
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, MaxResponseBytes+1))
	if err != nil {
		return result, errors.New("read response failed")
	}
	if len(b) > MaxResponseBytes {
		return result, errors.New("response exceeds size limit")
	}
	// Only bootstrap status may contain credentials. Callers never print these.
	if len(b) != 0 {
		d := json.NewDecoder(bytes.NewReader(b))
		if err = d.Decode(&result); err != nil && res.StatusCode >= 200 && res.StatusCode < 300 {
			return result, errors.New("invalid control response")
		}
		var extra any
		if err == nil && d.Decode(&extra) != io.EOF {
			return result, errors.New("invalid control response")
		}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return result, &HTTPError{Status: res.StatusCode, Code: result.Code}
	}
	if result.State != "pending" && result.State != "approved" && result.State != "revoked" {
		return result, errors.New("invalid device state")
	}
	return result, nil
}

func (c *Client) Join(ctx context.Context, ticket string, host HostInfo) (ControlResponse, error) {
	if len(ticket) > 1024 {
		return ControlResponse{}, errors.New("legacy join ticket exceeds 1024 bytes")
	}
	path := "/v1/enroll"
	if c.config.Bootstrap {
		path = "/bootstrap/enroll"
	}
	join := JoinRequest{
		Protocol: ProtocolVersion, NodeID: c.config.NodeID, Group: c.config.Group,
		Name: c.config.Name, DeviceKey: c.config.DeviceKey, Ticket: ticket, Host: host,
	}
	if c.config.IdentityMode == "ed25519" {
		publicKey, err := c.config.SSHPublicKey()
		if err != nil {
			return ControlResponse{}, err
		}
		join.Protocol, join.PublicKey, join.DeviceKey, join.Ticket = 2, publicKey, "", ""
	}
	result, err := c.request(ctx, http.MethodPost, path, join)
	if err != nil && c.config.IdentityMode == "ed25519" {
		// Registration closes atomically after the first success. If its reply
		// was lost, recover by proving the saved identity through the separate
		// status endpoint; never reopen registration or accept another identity.
		var rejected *HTTPError
		if !errors.As(err, &rejected) || rejected.Code == "registration_closed" || rejected.Code == "invitation_invalid_or_expired" || rejected.Code == "invitation_used" {
			if known, lookupErr := c.Status(ctx); lookupErr == nil && known.State == "approved" {
				return known, nil
			}
		}
	}
	return result, err
}

func (c *Client) BootstrapStatus(ctx context.Context) (ControlResponse, error) {
	return c.request(ctx, http.MethodPost, "/bootstrap/status", nil)
}

func (c *Client) Status(ctx context.Context) (ControlResponse, error) {
	if c.config.Bootstrap && c.config.Access.ClientID == "" {
		return c.BootstrapStatus(ctx)
	}
	return c.request(ctx, http.MethodGet, "/v1/nodes/"+c.config.NodeID+"/status", nil)
}

func (c *Client) Report(ctx context.Context, report ReportRequest) (ControlResponse, error) {
	return c.request(ctx, http.MethodPost, "/v1/metrics", report)
}

func (c *Client) Leave(ctx context.Context) (ControlResponse, error) {
	return c.request(ctx, http.MethodDelete, "/v1/nodes/"+c.config.NodeID, nil)
}
