package upgrade

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The release-version rule agrees with crhs's on the shared cases (test/interop/release_versions.json).
func TestReleaseVersionsAgreeWithCrhs(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "test", "interop", "release_versions.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases struct {
		Release    []string `json:"release"`
		NotRelease []string `json:"not_release"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, v := range cases.Release {
		if !IsReleaseVersion(v) {
			t.Errorf("%q is a release", v)
		}
	}
	for _, v := range cases.NotRelease {
		if IsReleaseVersion(v) {
			t.Errorf("%q is not a release", v)
		}
	}
}
