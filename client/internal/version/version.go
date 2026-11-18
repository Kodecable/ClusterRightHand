// Package version exposes build information set via -ldflags.
package version

import (
	"fmt"
	"runtime"
)

var (
	Version = "dev"
	Commit  = "unknown"
)

func String() string {
	return StringFor("crha")
}

// StringFor renders the version of the named binary; crhu is the second binary of the module.
func StringFor(tool string) string {
	managed := ""
	if PackageManaged {
		managed = ", package-managed"
	}
	return fmt.Sprintf("%s %s (commit %s, %s, %s/%s%s)", tool, Version, Commit, runtime.Version(), runtime.GOOS, runtime.GOARCH, managed)
}
