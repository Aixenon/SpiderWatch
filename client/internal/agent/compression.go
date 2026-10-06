package agent

import (
	"bytes"
	"compress/gzip"
	"errors"
)

// One fast compressor per connection, reset between independent report frames.
// Small or incompressible data uses the original text frame.
type reportCompressor struct {
	buffer bytes.Buffer
	writer *gzip.Writer
}

func (c *reportCompressor) encode(data []byte) ([]byte, bool, error) {
	if len(data) > MaxRequestBytes {
		return nil, false, errors.New("report exceeds size limit")
	}
	if len(data) < 256 {
		return data, false, nil
	}
	c.buffer.Reset()
	if c.writer == nil {
		var err error
		c.writer, err = gzip.NewWriterLevel(&c.buffer, gzip.BestSpeed)
		if err != nil {
			return nil, false, err
		}
	} else {
		c.writer.Reset(&c.buffer)
	}
	if _, err := c.writer.Write(data); err != nil {
		return nil, false, err
	}
	if err := c.writer.Close(); err != nil {
		return nil, false, err
	}
	if c.buffer.Len() >= len(data) {
		return data, false, nil
	}
	return c.buffer.Bytes(), true, nil
}
