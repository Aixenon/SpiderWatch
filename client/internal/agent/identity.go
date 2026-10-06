package agent

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The seed is a dedicated agent identity, not a login/host SSH private key.
// Go's standard library provides Ed25519 without ssh.exe, CGO or a daemon.
func (c *Config) EnsureIdentity() error {
	if c.IdentitySeed != "" {
		_, err := c.identityPrivateKey()
		return err
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return err
	}
	c.IdentitySeed = base64.StdEncoding.EncodeToString(seed)
	return nil
}

func (c Config) identityPrivateKey() (ed25519.PrivateKey, error) {
	seed, err := base64.StdEncoding.DecodeString(c.IdentitySeed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("invalid agent identity key")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func (c Config) SSHPublicKey() (string, error) {
	key, err := c.identityPrivateKey()
	if err != nil {
		return "", err
	}
	wire := make([]byte, 51)
	binary.BigEndian.PutUint32(wire[:4], 11)
	copy(wire[4:15], "ssh-ed25519")
	binary.BigEndian.PutUint32(wire[15:19], ed25519.PublicKeySize)
	copy(wire[19:], key.Public().(ed25519.PublicKey))
	return "ssh-ed25519 " + base64.StdEncoding.EncodeToString(wire), nil
}

// Parse a copied enrollment command without putting its invitation in a
// HTTP URL. The fragment is local input; credentials travel only in headers.
func ParseJoinServer(value string) (server, invitation string, err error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" {
		return "", "", errors.New("invalid enrollment server")
	}
	fragment, err := url.ParseQuery(u.EscapedFragment())
	if err != nil {
		return "", "", errors.New("invalid enrollment fragment")
	}
	for key, values := range fragment {
		if (key != "invite" && key != "gate") || len(values) != 1 {
			return "", "", errors.New("invalid enrollment fragment")
		}
	}
	// Accept an older command's gate field for compatibility, but discard it.
	invitation, legacyGate := fragment.Get("invite"), fragment.Get("gate")
	if len(invitation) > 256 || len(legacyGate) > 256 || strings.ContainsAny(invitation+legacyGate, "\r\n\x00") {
		return "", "", errors.New("invalid enrollment credentials")
	}
	u.Fragment, u.RawFragment = "", ""
	return strings.TrimRight(u.String(), "/"), invitation, nil
}

func (c *Client) authorizeRequest(req *http.Request, body []byte) error {
	req.Header.Set("X-Monitor-Node-ID", c.config.NodeID)
	if c.config.IdentityMode != "ed25519" {
		req.Header.Set("Authorization", "Bearer "+c.config.DeviceKey)
		return nil
	}
	key, err := c.config.identityPrivateKey()
	if err != nil {
		return err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	nonceText := hex.EncodeToString(nonce[:])
	req.Header.Set("X-Monitor-Time", timestamp)
	req.Header.Set("X-Monitor-Nonce", nonceText)
	u := *req.URL
	if u.Scheme == "wss" {
		u.Scheme = "https"
	}
	if u.Scheme == "ws" {
		u.Scheme = "http"
	}
	// WHATWG URL.origin omits default ports, as does the Worker verifier.
	host := u.Host
	if u.Scheme == "https" && u.Port() == "443" {
		host = strings.TrimSuffix(host, ":443")
	}
	if u.Scheme == "http" && u.Port() == "80" {
		host = strings.TrimSuffix(host, ":80")
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	digest := sha256.Sum256(body)
	payload := strings.Join([]string{"cf-monitor-auth-v1", req.Method, u.Scheme + "://" + strings.ToLower(host), path,
		c.config.NodeID, timestamp, nonceText, hex.EncodeToString(digest[:])}, "\n")
	req.Header.Set("X-Monitor-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(payload))))
	return nil
}
