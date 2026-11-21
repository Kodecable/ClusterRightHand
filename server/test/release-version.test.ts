/**
 * Versions (doc/design/distribution.md "Versions"): the one rule that makes a version a release, shared
 * with crha's installer through test/interop/release_versions.json, and the build's mapping of tags and
 * git describe output onto it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveVersion, versionFromDescribe, versionFromTag } from "../../scripts/version.ts";
import { isPrerelease, isReleaseVersion } from "../src/util/release-version.ts";

const cases = JSON.parse(
	readFileSync(new URL("../../test/interop/release_versions.json", import.meta.url), "utf8"),
) as { release: string[]; prerelease: string[]; not_release: string[] };

describe("release versions", () => {
	it("agree with the shared cases", () => {
		for (const v of cases.release) expect(isReleaseVersion(v), v).toBe(true);
		for (const v of cases.not_release) expect(isReleaseVersion(v), v).toBe(false);
		for (const v of cases.release) expect(isPrerelease(v), v).toBe(cases.prerelease.includes(v));
	});
});

describe("the build's version", () => {
	it("is the tag without its v, and a tag must name a release", () => {
		expect(versionFromTag("v0.2.0-rc.1")).toBe("0.2.0-rc.1");
		expect(() => versionFromTag("0.2.0")).toThrow(/not v followed/);
		expect(() => versionFromTag("v0.2")).toThrow(/not v followed/);
	});

	it("marks a build between tags with build metadata, so it is never a release", () => {
		expect(versionFromDescribe("v0.2.0-rc.1")).toBe("0.2.0-rc.1");
		expect(versionFromDescribe("v0.2.0-rc.1-dirty")).toBe("0.2.0-rc.1+dirty");
		expect(versionFromDescribe("v0.2.0-rc.1-1-gff672ae")).toBe("0.2.0-rc.1+1.gff672ae");
		expect(versionFromDescribe("v0.2.0-4-gabc1234-dirty")).toBe("0.2.0+4.gabc1234.dirty");
		expect(versionFromDescribe("abc1234")).toBe("0.0.0+gabc1234");
		for (const describe of ["v0.2.0-rc.1-1-gff672ae", "v0.2.0-rc.1-dirty", "abc1234-dirty"]) {
			expect(isReleaseVersion(versionFromDescribe(describe)), describe).toBe(false);
		}
	});

	it("follows CRH_VERSION, then the tag of a release run", async () => {
		expect(await resolveVersion({ CRH_VERSION: "9.9.9" })).toBe("9.9.9");
		expect(await resolveVersion({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.0.0-rc.2" })).toBe("1.0.0-rc.2");
		await expect(resolveVersion({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "nightly" })).rejects.toThrow();
	});
});
