package agent

import "strings"

// These bounded ASCII formats do not require a general-purpose regex engine.
func asciiAlphanumeric(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func validAgentVersion(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for i := range len(value) {
		c := value[i]
		if !asciiAlphanumeric(c) && c != '.' && c != '_' && c != '+' && c != '-' {
			return false
		}
	}
	return true
}

func validDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for i := range len(value) {
		c := value[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func validDistributionPath(value string) bool {
	if value == "" {
		return false
	}
	separator := true
	for i := range len(value) {
		c := value[i]
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' {
			separator = false
		} else if (c == '-' || c == '/') && !separator {
			separator = true
		} else {
			return false
		}
	}
	return !separator
}

func parseReleaseVersion(value string) (numbers [3]uint32, prerelease, ok bool) {
	core, suffix, prerelease := strings.Cut(value, "-")
	if prerelease {
		if len(suffix) == 0 || len(suffix) > 48 || !asciiAlphanumeric(suffix[0]) {
			return numbers, false, false
		}
		for i := range len(suffix) {
			c := suffix[i]
			if !asciiAlphanumeric(c) && c != '.' && c != '-' {
				return numbers, false, false
			}
		}
	}
	for i := range numbers {
		part, rest, hasDot := strings.Cut(core, ".")
		if hasDot != (i < 2) || len(part) == 0 || len(part) > 9 || (len(part) > 1 && part[0] == '0') {
			return numbers, false, false
		}
		for j := range len(part) {
			c := part[j]
			if c < '0' || c > '9' {
				return numbers, false, false
			}
			numbers[i] = numbers[i]*10 + uint32(c-'0')
		}
		core = rest
	}
	return numbers, prerelease, true
}

func validReleaseVersion(value string) bool {
	_, _, ok := parseReleaseVersion(value)
	return ok
}
