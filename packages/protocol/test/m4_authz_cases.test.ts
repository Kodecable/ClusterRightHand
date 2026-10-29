import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { taskSpecFromJson } from "../src/json.ts";
import { type AuthzCases, buildAuthzCases } from "./m4_authz_cases.ts";

const fixtureText = readFileSync(new URL("../../../test/interop/m4_authz_cases.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureText) as AuthzCases;

const CODES = new Set([
	"accepted",
	"authorization_required",
	"authorization_invalid",
	"authorization_expired",
	"authorization_rejected",
	"already_accepted",
]);

describe("test/interop/m4_authz_cases.json", () => {
	it("matches the generator", () => {
		expect(fixture).toEqual(buildAuthzCases());
	});

	it("is well-formed", () => {
		const ids = fixture.cases.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const c of fixture.cases) {
			expect(CODES.has(c.expect.result), c.id).toBe(true);
			expect(c.expect.step === null, c.id).toBe(c.expect.result === "accepted");
			taskSpecFromJson(c.task.spec);
		}
		for (const t of fixture.targets) taskSpecFromJson(t.spec);
	});
});
