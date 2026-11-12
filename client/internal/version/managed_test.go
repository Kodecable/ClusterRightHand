//go:build !pkgmanaged

package version

import (
	"strings"
	"testing"
)

func TestPackageManagedDefault(t *testing.T) {
	if PackageManaged {
		t.Fatal("PackageManaged is true without the pkgmanaged build tag")
	}
	if got := String(); strings.Contains(got, "package-managed") {
		t.Fatalf("String() = %q, want no package-managed marker", got)
	}
}
