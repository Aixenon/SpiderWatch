package agent

import "testing"

func TestNetworkCodeFormatAndLegacyNormalization(t *testing.T) {
	for _, value := range []string{"A1B2C3D4E5F6G7H8", "abcdefghijklmnop", "0123456789012345", "100000000001"} {
		if !ValidJoinCode(value) {
			t.Errorf("valid code rejected: %q", value)
		}
	}
	for _, value := range []string{"", "abc", "12345678901", "1234567890123", "abcdefghijklmno_", "abcdefghijklmn-o", "abcdefghijklmnopq", "abcdefghijklmn中"} {
		if ValidJoinCode(value) {
			t.Errorf("invalid code accepted: %q", value)
		}
	}
	if got := NormalizeNetworkCode("A1B2C3D4E5F6G7H8"); got != "a1b2c3d4e5f6g7h8" {
		t.Fatalf("uppercase code was not canonicalized: %q", got)
	}
	for _, legacy := range []string{"Legacy-Network", "LEGACY_group", "100000000001"} {
		if got := NormalizeNetworkCode(legacy); got != legacy {
			t.Errorf("legacy group changed: %q -> %q", legacy, got)
		}
	}
}
