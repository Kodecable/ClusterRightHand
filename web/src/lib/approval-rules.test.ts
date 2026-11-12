import { describe, expect, test } from "vitest";
import { actorLabel, alwaysRule, shellQuote } from "./approval-rules";

describe("alwaysRule", () => {
	test("builds the allow rule from the reported operation", () => {
		expect(alwaysRule({ method: "exec", target: "/bin/sh -c 'echo hi; ls'" }, ["n1"], "exact", true)).toEqual({
			action: "allow",
			method: "exec",
			nodes: ["n1"],
			privileged: true,
			exact: "/bin/sh -c 'echo hi; ls'",
		});
		expect(alwaysRule({ method: "file.write", target: "/etc/x" }, ["n1", "n2"], "prefix", false)).toEqual({
			action: "allow",
			method: "file.write",
			nodes: ["n1", "n2"],
			privileged: false,
			prefix: "/etc/x",
		});
	});

	test("carries the privileged flag so ordinary tasks are not allowed by accident", () => {
		expect(alwaysRule({ method: "exec", target: "x" }, ["n"], "exact", false)).toMatchObject({ privileged: false });
	});

	test("returns undefined without an operation", () => {
		expect(alwaysRule(null, ["n"], "exact", true)).toBeUndefined();
	});
});

describe("actorLabel", () => {
	test("resolves API token names", () => {
		const names = new Map([["t1", "deploy bot"]]);
		expect(actorLabel("api_token", "t1", names)).toBe("API token deploy bot");
		expect(actorLabel("api_token", "missing", names)).toBe("API token missing");
		expect(actorLabel("user", "u1", names)).toBe("user u1");
	});
});

describe("shellQuote", () => {
	test("quotes only when needed", () => {
		expect(shellQuote("a/b-c_d.e:f,g=h+i@j%k")).toBe("a/b-c_d.e:f,g=h+i@j%k");
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
		expect(shellQuote("")).toBe("''");
	});
});
