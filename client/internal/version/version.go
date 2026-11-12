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
	managed := ""
	if PackageManaged {
		managed = ", package-managed"
	}
	return fmt.Sprintf("crha %s (commit %s, %s, %s/%s%s)", Version, Commit, runtime.Version(), runtime.GOOS, runtime.GOARCH, managed)
}
