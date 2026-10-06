package agent

import (
	"encoding/json"
	"testing"
)

func TestPlatformCatalogueAndUpdateVariants(t *testing.T) {
	var platforms []releasePlatform
	if err := json.Unmarshal(releasePlatformsJSON, &platforms); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, p := range platforms {
		file := assetFilename(p.OS, p.Arch)
		if !validReleasePlatform(p.OS, p.Arch) || !validAssetFile(file) || seen[file] {
			t.Fatalf("invalid/duplicate target %s", file)
		}
		seen[file] = true
	}
	for _, bad := range []releasePlatform{{OS: "darwin", Arch: "386"}, {OS: "linux", Arch: "riscv32"}, {OS: "linux", Arch: "mips"}, {OS: "linux", Arch: "arm"}, {OS: "windows", Arch: "armv7"}} {
		if validReleasePlatform(bad.OS, bad.Arch) || validAssetFile(assetFilename(bad.OS, bad.Arch)) {
			t.Fatalf("accepted unsupported ABI: %+v", bad)
		}
	}
	old := BuildArch
	defer func() { BuildArch = old }()
	for _, arch := range []string{"armv5", "armv7", "mipsle-softfloat", "mips64-softfloat"} {
		BuildArch = arch
		if releaseArch() != arch {
			t.Fatalf("lost release ABI %s", arch)
		}
	}
}
