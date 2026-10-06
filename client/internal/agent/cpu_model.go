package agent

import (
	"bufio"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxCPUModelBytes = 128
const maxCPUInfoBytes = 64 << 10

func sanitizeCPUModel(model string) string {
	var result strings.Builder
	result.Grow(min(len(model), maxCPUModelBytes))
	space := false
	for len(model) != 0 {
		r, size := utf8.DecodeRuneInString(model)
		model = model[size:]
		if r == utf8.RuneError && size == 1 {
			continue
		}
		if unicode.IsSpace(r) || !unicode.IsPrint(r) {
			space = result.Len() > 0
			continue
		}
		needed := utf8.RuneLen(r)
		if space {
			needed++
		}
		if result.Len()+needed > maxCPUModelBytes {
			break
		}
		if space {
			result.WriteByte(' ')
		}
		result.WriteRune(r)
		space = false
	}
	return result.String()
}

// Read only a small prefix once at startup. In particular, processor numbers,
// machine/board labels and ISA feature lists are not processor model names.
func parseCPUModel(reader io.Reader) string {
	s := bufio.NewScanner(io.LimitReader(reader, maxCPUInfoBytes))
	s.Buffer(make([]byte, 1024), maxCPUInfoBytes)
	model, rank := "", 4
	for s.Scan() {
		key, raw, ok := strings.Cut(s.Text(), ":")
		if !ok {
			continue
		}
		priority := 4
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "model name", "cpu model":
			priority = 1
		case "uarch", "cpu":
			priority = 2
		case "processor":
			priority = 3
		}
		if priority >= rank {
			continue
		}
		value := sanitizeCPUModel(raw)
		if value == "" || strings.EqualFold(value, "unknown") || strings.EqualFold(value, "n/a") {
			continue
		}
		numeric := true
		for _, r := range value {
			if r < '0' || r > '9' {
				numeric = false
				break
			}
		}
		if numeric {
			continue
		}
		model, rank = value, priority
		if rank == 1 {
			break
		}
	}
	return model
}
