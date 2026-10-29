import { readFileSync } from "node:fs";
import type { GuardRule, TaskSpec } from "@crh/protocol";
import { taskSpecFromJson } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import {
	envAllowed,
	GuardRuleError,
	guardAllows,
	MAX_GUARD_PATTERN_BYTES,
	PrivilegedTargetError,
	privilegedTarget,
	validateGuardRules,
} from "../src/privilege/guard.ts";

const any = (method: GuardRule["method"] = "exec"): GuardRule => ({ method, match: "any", pattern: "" });
const prefix = (pattern: string, method: GuardRule["method"] = "exec"): GuardRule => ({
	method,
	match: "prefix",
	pattern,
});
const regex = (pattern: string, method: GuardRule["method"] = "exec"): GuardRule => ({
	method,
	match: "regex",
	pattern,
});

const entry = (allow: GuardRule[], deny: GuardRule[] = []) => ({ allow, deny });

describe("guard rules", () => {
	it("treats prefix rules as a literal prefix", () => {
		const rules = entry([prefix("systemctl restart ")]);
		expect(guardAllows(rules, "exec", "systemctl restart nginx")).toBe(true);
		expect(guardAllows(rules, "exec", "systemctl restart ")).toBe(true);
		expect(guardAllows(rules, "exec", "systemctl stop nginx")).toBe(false);
		expect(guardAllows(rules, "exec", "/bin/sh -c 'systemctl restart nginx'")).toBe(false);
	});

	it("matches regex rules against the whole target with dot-all semantics", () => {
		const rules = entry([regex("apt-get (update|upgrade -y)")]);
		expect(guardAllows(rules, "exec", "apt-get update")).toBe(true);
		expect(guardAllows(rules, "exec", "apt-get upgrade -y")).toBe(true);
		expect(guardAllows(rules, "exec", "apt-get update --fix-missing")).toBe(false);
		expect(guardAllows(rules, "exec", "sudo apt-get update")).toBe(false);
		const dotall = entry([regex("a.*b")]);
		expect(guardAllows(dotall, "exec", "a\nb")).toBe(true);
	});

	it("lets a file.write allow rule cover reads but a deny rule stay method-exact", () => {
		const allowWrite = entry([prefix("/etc/nginx/", "file.write")]);
		expect(guardAllows(allowWrite, "file.write", "/etc/nginx/nginx.conf")).toBe(true);
		expect(guardAllows(allowWrite, "file.read", "/etc/nginx/nginx.conf")).toBe(true);
		const denyWrite = entry([], [prefix("/etc/crha/", "file.write")]);
		expect(guardAllows(denyWrite, "file.write", "/etc/crha/privileged.toml")).toBe(false);
		expect(guardAllows(denyWrite, "file.read", "/etc/crha/privileged.toml")).toBe(true);
	});

	it("applies deny before allow and lets an empty allow list pass", () => {
		const rules = entry([any("file.read")], [regex("/etc/(shadow|gshadow|sudoers.*)", "file.read")]);
		expect(guardAllows(rules, "file.read", "/etc/hosts")).toBe(true);
		expect(guardAllows(rules, "file.read", "/etc/shadow")).toBe(false);
		expect(guardAllows(entry([], []), "file.write", "/anywhere")).toBe(true);
	});

	it("treats an uncompilable allow rule as never matching and a deny rule as always matching", () => {
		// Lookahead is outside RE2's syntax; never fall back to JS RegExp.
		const allowed = entry([regex("(?=lookahead)")]);
		expect(guardAllows(allowed, "exec", "(?=lookahead)")).toBe(false);
		const denied = entry([], [regex("(?=lookahead)")]);
		expect(guardAllows(denied, "exec", "anything")).toBe(false);
		// One bad rule invalidates the whole list, so the good rule cannot widen access either.
		const mixed = entry([prefix("ls "), regex("(?=x)")]);
		expect(guardAllows(mixed, "exec", "ls -l")).toBe(false);
	});

	it("rejects rules over the size limit and invalid any/pattern combinations", () => {
		expect(() => validateGuardRules([regex("a".repeat(MAX_GUARD_PATTERN_BYTES))])).not.toThrow();
		expect(() => validateGuardRules([regex("a".repeat(MAX_GUARD_PATTERN_BYTES + 1))])).toThrow(GuardRuleError);
		// The limit is bytes, not UTF-16 code units: 400 three-byte characters are 1200 bytes.
		expect(() => validateGuardRules([regex("好".repeat(400))])).toThrow(/bytes/);
		expect(() => validateGuardRules([{ method: "exec", match: "any", pattern: "x" }])).toThrow(/non-empty pattern/);
		expect(guardAllows(entry([{ method: "exec", match: "any", pattern: "x" }]), "exec", "ls")).toBe(false);
	});

	it("accepts the characters of the Go/RE2 common subset", () => {
		expect(() =>
			validateGuardRules([regex("(?i)^\\p{Latin}+$"), regex("^[[:alpha:]]+$"), regex("a{2,3}")]),
		).not.toThrow();
	});
});

describe("env_allow", () => {
	const spec = (env: Record<string, string>): TaskSpec => ({
		kind: "exec",
		command: { argv: ["env"] },
		env,
		cwd: "",
		stdin: null,
	});

	it("allows only listed environment variables, on exec tasks", () => {
		expect(envAllowed(spec({ DEBIAN_FRONTEND: "noninteractive" }), ["DEBIAN_FRONTEND"])).toBe(true);
		expect(envAllowed(spec({ PATH: "/tmp" }), ["DEBIAN_FRONTEND"])).toBe(false);
		expect(envAllowed(spec({}), [])).toBe(true);
		expect(envAllowed({ kind: "file.stat", path: "/etc" }, [])).toBe(true);
	});
});

describe("privileged targets", () => {
	it("renders every shared target the same way as crha", () => {
		const fixture = JSON.parse(
			readFileSync(new URL("../../test/interop/m4_authz_cases.json", import.meta.url), "utf8"),
		) as { targets: { spec: unknown; method: string; target: string }[] };
		for (const target of fixture.targets) {
			expect(privilegedTarget(taskSpecFromJson(target.spec))).toEqual({
				method: target.method,
				target: target.target,
			});
		}
	});

	it("quotes shell-mode argv as /bin/sh -c", () => {
		expect(
			privilegedTarget({
				kind: "exec",
				command: { shell: "systemctl restart nginx; id" },
				env: {},
				cwd: "",
				stdin: null,
			}),
		).toEqual({ method: "exec", target: "/bin/sh -c 'systemctl restart nginx; id'" });
	});

	it.each([
		["relative path", { kind: "file.stat", path: "etc/hosts" }],
		["dot-dot", { kind: "file.stat", path: "/etc/nginx/../shadow" }],
		["dot", { kind: "file.read", path: "/etc/./hosts", offset: 0, limit: 0 }],
		["repeated slash", { kind: "file.read", path: "/etc//hosts", offset: 0, limit: 0 }],
		["trailing slash", { kind: "file.list", path: "/etc/nginx/", limit: 0 }],
		["empty path", { kind: "file.stat", path: "" }],
	])("rejects a %s", (_name, spec) => {
		expect(() => privilegedTarget(spec as TaskSpec)).toThrow(PrivilegedTargetError);
	});

	it("accepts the clean absolute root and rejects an empty argv", () => {
		expect(privilegedTarget({ kind: "file.list", path: "/", limit: 0 })).toEqual({
			method: "file.read",
			target: "/",
		});
		expect(() => privilegedTarget({ kind: "exec", command: { argv: [] }, env: {}, cwd: "", stdin: null })).toThrow(
			/empty argv/,
		);
	});
});
