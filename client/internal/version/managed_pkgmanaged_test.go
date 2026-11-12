//go:build pkgmanaged

package version

import (
	"strings"
	"testing"
)

func TestPackageManagedTag(t *testing.T) {
	if !PackageManaged {
		t.Fatal("PackageManaged is false with the pkgmanaged build tag")
	}
	if got := String(); !strings.Contains(got, "package-managed") {
		t.Fatalf("String() = %q, want the package-managed marker", got)
	}
}
