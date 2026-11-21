package upgrade

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// releaseVersion is a release's version: x.y.z with an optional prerelease. `dev` and builds between
// tags, which carry + build metadata (scripts/version.ts), are not releases.
var releaseVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$`)

// IsReleaseVersion reports whether v names a release.
func IsReleaseVersion(v string) bool { return releaseVersion.MatchString(v) }

// compareVersions orders two release versions by SemVer precedence, as crhs does: negative when a is
// older. A prerelease sorts before its release. Versions that are not releases compare as equal, so
// callers check IsReleaseVersion first.
func compareVersions(a, b string) int {
	ma, mb := releaseVersion.FindStringSubmatch(a), releaseVersion.FindStringSubmatch(b)
	if ma == nil || mb == nil {
		return 0
	}
	for i := 1; i <= 3; i++ {
		x, _ := strconv.Atoi(ma[i])
		y, _ := strconv.Atoi(mb[i])
		if x != y {
			return x - y
		}
	}
	pa, pb := strings.TrimPrefix(ma[4], "-"), strings.TrimPrefix(mb[4], "-")
	switch {
	case pa == pb:
		return 0
	case pa == "":
		return 1
	case pb == "":
		return -1
	}
	xa, xb := strings.Split(pa, "."), strings.Split(pb, ".")
	for i := 0; i < len(xa) && i < len(xb); i++ {
		if xa[i] == xb[i] {
			continue
		}
		na, ea := strconv.Atoi(xa[i])
		nb, eb := strconv.Atoi(xb[i])
		switch {
		case ea == nil && eb == nil:
			return na - nb
		case ea == nil:
			return -1
		case eb == nil:
			return 1
		case xa[i] < xb[i]:
			return -1
		default:
			return 1
		}
	}
	return len(xa) - len(xb)
}

// checkUpgrade is the one rule for the versions of an upgrade, which the old binary checks before it
// hands over and the new one before it changes anything: from a release to a newer release. There is
// no downgrade, since migrations only go forward.
func checkUpgrade(from, to string) error {
	if !IsReleaseVersion(from) || !IsReleaseVersion(to) || compareVersions(from, to) >= 0 {
		return fmt.Errorf("an upgrade goes from a release to a newer release, not from %s to %s", from, to)
	}
	return nil
}
