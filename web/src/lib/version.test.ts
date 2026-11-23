import { describe, expect, test } from "vitest";
import { versionLabel } from "./version";

describe("versionLabel", () => {
	test("prefixes a version with v", () => {
		expect(versionLabel("0.4.0")).toBe("v0.4.0");
		expect(versionLabel("0.4.0-rc.1")).toBe("v0.4.0-rc.1");
		expect(versionLabel("0.4.0-rc.1+4.gabc1234")).toBe("v0.4.0-rc.1+4.gabc1234");
		expect(versionLabel("0.0.0+gabc1234.dirty")).toBe("v0.0.0+gabc1234.dirty");
	});

	test("keeps dev as is", () => {
		expect(versionLabel("dev")).toBe("dev");
	});
});
