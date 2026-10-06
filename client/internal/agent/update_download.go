package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	parallelUpdateMinimum = 256 << 10
	updateDownloadWorkers = 4
	updateCopyBufferBytes = 32 << 10
	updateDownloadTimeout = 2 * time.Minute
)

// DownloadUpdate writes into one caller-owned temporary file. Static parts use
// four bounded streams; legacy servers and small files use one full-file stream.
// Nothing is installed until the complete file matches the trusted manifest.
func (c *Client) DownloadUpdate(ctx context.Context, asset UpdateAsset, destination *os.File) error {
	if asset.Bytes < 1024 || asset.Bytes > MaxBinaryBytes || !validDigest(asset.SHA256) {
		return errors.New("invalid update size or digest")
	}
	u, err := c.updateURL(asset.URL, false)
	if err != nil {
		return err
	}
	if destination == nil {
		return errors.New("missing update destination")
	}
	info, err := destination.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("invalid update destination")
	}
	if err = resetUpdateDownload(destination); err != nil {
		return err
	}
	complete := false
	defer func() {
		if !complete {
			_ = resetUpdateDownload(destination)
		}
	}()
	ctx, cancel := context.WithTimeout(ctx, updateDownloadTimeout)
	defer cancel()
	if asset.Bytes >= parallelUpdateMinimum && strings.HasPrefix(u.Path, "/downloads/") {
		err = c.downloadUpdateParts(ctx, u, asset, destination)
		if err == nil {
			err = verifyUpdateFile(destination.Name(), asset)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err == nil {
			if err = destination.Sync(); err != nil {
				return errors.New("cannot sync downloaded update")
			}
			complete = true
			return nil
		}
		// Older deployments have no static parts. Every part request has stopped
		// before discarding its bytes, so late writes cannot corrupt the fallback.
		if err = resetUpdateDownload(destination); err != nil {
			return err
		}
	}
	res, err := c.updateRequest(ctx, u.String(), updateDownloadTimeout)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	hash := sha256.New()
	err = copyUpdateResponse(res, io.MultiWriter(io.NewOffsetWriter(destination, 0), hash), asset.Bytes)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != asset.SHA256 {
		return errors.New("update SHA-256 verification failed")
	}
	if err = destination.Sync(); err != nil {
		return errors.New("cannot sync downloaded update")
	}
	complete = true
	return nil
}

func resetUpdateDownload(destination *os.File) error {
	if err := destination.Truncate(0); err != nil {
		return errors.New("cannot clear staged update")
	}
	if _, err := destination.Seek(0, io.SeekStart); err != nil {
		return errors.New("cannot reset staged update")
	}
	return nil
}

func copyUpdateResponse(response *http.Response, destination io.Writer, size int64) error {
	if response.Header.Get("Content-Range") != "" || response.ContentLength >= 0 && response.ContentLength != size {
		return errors.New("update response length mismatch")
	}
	// Read the overflow byte separately: it must never be written over the next
	// part or beyond the file budget, even when a server sends chunked encoding.
	n, err := io.CopyBuffer(destination, io.LimitReader(response.Body, size), make([]byte, updateCopyBufferBytes))
	if err != nil || n != size {
		return errors.New("update response is incomplete")
	}
	var extra [1]byte
	if n, err := io.ReadFull(response.Body, extra[:]); n != 0 || err != io.EOF {
		return errors.New("update response exceeds expected size")
	}
	return nil
}

func (c *Client) downloadUpdateParts(ctx context.Context, origin *url.URL, asset UpdateAsset, destination *os.File) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Keep four connections only for this update. The resident monitoring
	// transport keeps its original one-connection limits and HTTP/2 settings.
	transport := c.transport.Clone()
	transport.MaxConnsPerHost = updateDownloadWorkers
	transport.MaxIdleConns = updateDownloadWorkers
	transport.MaxIdleConnsPerHost = updateDownloadWorkers
	defer transport.CloseIdleConnections()
	httpClient := *c.http
	httpClient.Transport = transport
	downloader := Client{config: c.config, http: &httpClient, transport: transport}
	partSize := (asset.Bytes + updateDownloadWorkers - 1) / updateDownloadWorkers
	results := make(chan error, updateDownloadWorkers)
	for index := range updateDownloadWorkers {
		go func() {
			endpoint := *origin
			endpoint.Path = "/downloads/parts/" + asset.SHA256 + "/" + strconv.Itoa(index)
			response, err := downloader.updateRequest(ctx, endpoint.String(), updateDownloadTimeout)
			if err == nil {
				offset := int64(index) * partSize
				size := min(partSize, asset.Bytes-offset)
				err = copyUpdateResponse(response, io.NewOffsetWriter(destination, offset), size)
				response.Body.Close()
			}
			results <- err
		}()
	}
	var failure error
	for range updateDownloadWorkers {
		if err := <-results; err != nil && failure == nil {
			failure = err
			cancel()
		}
	}
	return failure
}
