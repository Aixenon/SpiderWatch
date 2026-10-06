package agent

import (
	_ "embed"
	"encoding/json"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
)

//go:embed platforms.json
var releasePlatformsJSON []byte

// BuildArch is set by the release builder so ARM/MIPS updates retain their ABI.
var BuildArch string

type releasePlatform struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
	file string
}

func releaseArch() string {
	if BuildArch != "" {
		return BuildArch
	}
	if runtime.GOARCH == "arm" {
		if info, ok := debug.ReadBuildInfo(); ok {
			for _, s := range info.Settings {
				if s.Key == "GOARM" {
					return "armv" + strings.Split(s.Value, ",")[0]
				}
			}
		}
		return "armv5"
	}
	if strings.HasPrefix(runtime.GOARCH, "mips") {
		return runtime.GOARCH + "-softfloat"
	}
	return runtime.GOARCH
}
func assetFilename(goos, arch string) string {
	name := "spider-watch-" + goos + "-" + arch
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// The embedded catalogue is immutable. Decode it only when an update first
// needs it, and share the bounded result across subsequent validations.
var releasePlatforms = sync.OnceValue(func() []releasePlatform {
	var platforms []releasePlatform
	if json.Unmarshal(releasePlatformsJSON, &platforms) != nil {
		return nil
	}
	for i := range platforms {
		platforms[i].file = assetFilename(platforms[i].OS, platforms[i].Arch)
	}
	return platforms
})

func validReleasePlatform(goos, arch string) bool {
	for _, p := range releasePlatforms() {
		if p.OS == goos && p.Arch == arch {
			return true
		}
	}
	return false
}
func validAssetFile(name string) bool {
	for _, p := range releasePlatforms() {
		if name == p.file {
			return true
		}
	}
	return false
}
