/**
 * What makes a version a release (doc/design/distribution.md "Versions"): `x.y.z`, optionally with a
 * SemVer prerelease (`1.3.0-rc.1`), and no build metadata. The release tag is `v` followed by it. A build
 * between tags carries `+…` build metadata (scripts/version.ts), so it is never a release. The build
 * scripts and crhs share this one rule; crha's installer has the same pattern in Go
 * (client/internal/upgrade/version.go), and both are tested against the same cases.
 */
const RELEASE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;

/** Whether `version` names a release. */
export function isReleaseVersion(version: string): boolean {
	return RELEASE.test(version);
}

/** Whether `version` names a prerelease: a release with a prerelease part. */
export function isPrerelease(version: string): boolean {
	return isReleaseVersion(version) && version.includes("-");
}
