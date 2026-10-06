package agent

import (
	"math/rand/v2"
	"regexp"
	"strings"
	"testing"
)

// Keep the previous accepted formats as a test oracle. regexp is linked only
// into tests, so removing it from production cannot relax update validation.
func TestLightweightValidatorsPreserveAcceptedFormats(t *testing.T) {
	checks := []struct {
		pattern string
		valid   func(string) bool
	}{
		{`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,47}))?$`, validReleaseVersion},
		{`^[A-Za-z0-9._+\-]{1,64}$`, validAgentVersion},
		{`^[a-z0-9]+(?:[-/][a-z0-9]+)*$`, validDistributionPath},
		{`^[a-f0-9]{64}$`, validDigest},
	}
	values := []string{"", "0.0.0", "1.2.3", "01.2.3", "1.2", "1.2.3.4", "1.2.3-", "1.2.3-.dev", "1.2.3-dev.1", "1.2.3-a..b", "999999999.0.0", "1000000000.0.0", "1.2.3+build", "1.2.3\n", "版本", "a\x00b", "a-b/c", "a--b", "a-/b", "/a", "a/", "a%2fb", "../a"}
	for _, n := range []int{1, 47, 48, 49, 63, 64, 65} {
		values = append(values, strings.Repeat("a", n), "1.2.3-"+strings.Repeat("a", n))
	}
	r := rand.New(rand.NewPCG(1, 2))
	for range 1500 {
		b := make([]byte, r.IntN(100))
		for i := range b {
			b[i] = byte(r.IntN(256))
		}
		values = append(values, string(b))
	}
	for _, check := range checks {
		oracle := regexp.MustCompile(check.pattern)
		for _, value := range values {
			if check.valid(value) != oracle.MatchString(value) {
				t.Fatalf("validation changed for %q against %s", value, check.pattern)
			}
		}
	}
}
