import { readFileSync } from "node:fs";
import { type TaskSpec, taskSpecFromJson } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import {
	type Action,
	type ChainLevel,
	evaluate,
	type Method,
	type Operation,
	operationOf,
	type Preset,
	parseRuleSet,
	presetRuleSet,
	type Rule,
	type RuleSet,
	ruleMatches,
} from "../src/policy/rules.ts";
import { UserError } from "../src/users/service.ts";

const NODE = { id: "node-id-1", name: "web-1", groups: ["web", "prod"] };

function op(method: Method, target: string, node = NODE, privileged = false): Operation {
	return { method, target, node, privileged };
}

function level(id: string, def: RuleSet["default"], rules: Rule[] = []): ChainLevel {
	return { scope: { type: "session", id }, set: { default: def, rules } };
}

function result(chain: ChainLevel[], o: Operation): Action {
	return evaluate(chain, o).result;
}

describe("ruleMatches", () => {
	it("matches any method, node and target when they are omitted", () => {
		expect(ruleMatches({ action: "allow" }, op("exec", "ls"))).toBe(true);
		expect(ruleMatches({ action: "deny" }, op("file.write", "/x"))).toBe(true);
	});

	it("matches exact targets by equality and prefix targets by startsWith", () => {
		expect(ruleMatches({ action: "allow", exact: "uptime" }, op("exec", "uptime"))).toBe(true);
		expect(ruleMatches({ action: "allow", exact: "uptime" }, op("exec", "uptime -p"))).toBe(false);
		expect(ruleMatches({ action: "allow", prefix: "systemctl status " }, op("exec", "systemctl status nginx"))).toBe(
			true,
		);
		expect(ruleMatches({ action: "allow", prefix: "systemctl status " }, op("exec", "systemctl statusx"))).toBe(false);
		expect(ruleMatches({ action: "allow", prefix: "" }, op("exec", "anything"))).toBe(true);
	});

	it("matches nodes by name, id and group", () => {
		const m = (nodes: string[]) => ruleMatches({ action: "deny", nodes }, op("exec", "ls"));
		expect(m(["web-1"])).toBe(true);
		expect(m(["node-id-1"])).toBe(true);
		expect(m(["group:prod"])).toBe(true);
		expect(m(["db-1", "group:web"])).toBe(true);
		expect(m(["web-2", "group:db"])).toBe(false);
		// A group name is not a node name, and a node name is not a group.
		expect(m(["prod"])).toBe(false);
		expect(m(["group:web-1"])).toBe(false);
	});

	it("applies method matching exactly, except allow file.write also covers file.read", () => {
		const cases: [Action, Method | undefined, Method, boolean][] = [
			["allow", "file.write", "file.read", true],
			["allow", "file.write", "file.write", true],
			["allow", "file.read", "file.write", false],
			["allow", "exec", "file.read", false],
			["deny", "file.write", "file.read", false],
			["deny", "file.write", "file.write", true],
			["require-approval", "file.write", "file.read", false],
			["require-approval", "file.write", "file.write", true],
			["deny", "file.read", "file.write", false],
			["deny", undefined, "file.read", true],
			["allow", "exec", "exec", true],
		];
		for (const [action, method, opMethod, expected] of cases) {
			expect(ruleMatches({ action, method }, op(opMethod, "/etc/x")), `${action} ${method} vs ${opMethod}`).toBe(
				expected,
			);
		}
	});

	it("requires all of method, node and target", () => {
		const rule: Rule = { action: "deny", method: "file.write", nodes: ["group:prod"], prefix: "/etc/crha/" };
		expect(ruleMatches(rule, op("file.write", "/etc/crha/a"))).toBe(true);
		expect(ruleMatches(rule, op("file.write", "/etc/other"))).toBe(false);
		expect(ruleMatches(rule, op("file.read", "/etc/crha/a"))).toBe(false);
		expect(ruleMatches(rule, op("file.write", "/etc/crha/a", { ...NODE, groups: ["web"] }))).toBe(false);
	});

	it("matches the privileged flag when it is set and both values when it is omitted", () => {
		const privileged = op("exec", "systemctl restart nginx", NODE, true);
		const ordinary = op("exec", "systemctl restart nginx");
		expect(ruleMatches({ action: "allow", privileged: true }, privileged)).toBe(true);
		expect(ruleMatches({ action: "allow", privileged: true }, ordinary)).toBe(false);
		expect(ruleMatches({ action: "allow", privileged: false }, privileged)).toBe(false);
		expect(ruleMatches({ action: "allow", privileged: false }, ordinary)).toBe(true);
		// Fail closed for a rule that does not look at the flag would be wrong here: omitted means both.
		expect(ruleMatches({ action: "deny" }, privileged)).toBe(true);
		expect(ruleMatches({ action: "deny" }, ordinary)).toBe(true);
		// The flag is one more condition, not a replacement: the other fields still have to match.
		expect(ruleMatches({ action: "allow", privileged: true, prefix: "uptime" }, privileged)).toBe(false);
		expect(ruleMatches({ action: "allow", privileged: true, nodes: ["group:web"] }, privileged)).toBe(true);
	});
});

describe("evaluate: a single level", () => {
	it("uses the default when no rule matches, without a rule index", () => {
		const ev = evaluate([level("root", "require-approval", [{ action: "allow", prefix: "x" }])], op("exec", "ls"));
		expect(ev.result).toBe("require-approval");
		expect(ev.levels).toEqual([
			{ scope: { type: "session", id: "root" }, own: "require-approval", effective: "require-approval" },
		]);
		expect("rule" in (ev.levels[0] as object)).toBe(false);
	});

	it("picks the strictest matching rule regardless of order", () => {
		const rules: Rule[] = [
			{ action: "allow" },
			{ action: "require-approval", prefix: "rm" },
			{ action: "deny", prefix: "rm -rf" },
		];
		const root = level("root", "allow", rules);
		const a = evaluate([root], op("exec", "rm -rf /"));
		expect(a.result).toBe("deny");
		expect(a.levels[0]?.rule).toBe(2);
		const b = evaluate([root], op("exec", "rm a"));
		expect(b.result).toBe("require-approval");
		expect(b.levels[0]?.rule).toBe(1);
		const c = evaluate([root], op("exec", "ls"));
		expect(c.levels[0]?.rule).toBe(0);
		expect(c.result).toBe("allow");
		const reversed = level("root", "deny", [...rules].reverse());
		expect(evaluate([reversed], op("exec", "rm -rf /")).levels[0]?.rule).toBe(0);
	});

	it("an allow rule overrides a restrictive default at the same level", () => {
		const root = level("root", "deny", [{ action: "allow", method: "exec", prefix: "uptime" }]);
		expect(result([root], op("exec", "uptime"))).toBe("allow");
		expect(result([root], op("exec", "reboot"))).toBe("deny");
	});

	it("a privileged rule decides only privileged tasks", () => {
		const forPrivileged = level("root", "deny", [{ action: "allow", method: "exec", privileged: true }]);
		expect(result([forPrivileged], op("exec", "uptime", NODE, true))).toBe("allow");
		expect(result([forPrivileged], op("exec", "uptime"))).toBe("deny");
		const forOrdinary = level("root", "deny", [{ action: "allow", method: "exec", privileged: false }]);
		expect(result([forOrdinary], op("exec", "uptime"))).toBe("allow");
		expect(result([forOrdinary], op("exec", "uptime", NODE, true))).toBe("deny");
		// Without the field a rule matches both, so the deny still catches the privileged task.
		const forBoth = level("root", "allow", [{ action: "deny", method: "exec" }]);
		expect(result([forBoth], op("exec", "uptime"))).toBe("deny");
		expect(result([forBoth], op("exec", "uptime", NODE, true))).toBe("deny");
	});

	it("the first of equally strict rules is the deciding one", () => {
		const root = level("root", "deny", [
			{ action: "allow", prefix: "a" },
			{ action: "allow", prefix: "ab" },
		]);
		expect(evaluate([root], op("exec", "abc")).levels[0]?.rule).toBe(0);
	});

	it("throws on an empty chain and on an inheriting root", () => {
		expect(() => evaluate([], op("exec", "ls"))).toThrow();
		expect(() => evaluate([level("root", "inherit")], op("exec", "ls"))).toThrow();
	});

	it("an inheriting root default is harmless when a rule matches (the default is only consulted without a match)", () => {
		const root = level("root", "inherit", [{ action: "allow" }]);
		expect(result([root], op("exec", "ls"))).toBe("allow");
	});
});

describe("evaluate: chains", () => {
	it("a sub-level that inherits adds nothing", () => {
		const chain = [level("root", "require-approval"), level("child", "inherit")];
		const ev = evaluate(chain, op("exec", "ls"));
		expect(ev.result).toBe("require-approval");
		expect(ev.levels.map((l) => [l.own, l.effective])).toEqual([
			["require-approval", "require-approval"],
			["inherit", "require-approval"],
		]);
	});

	it("a sub-level allow never loosens require-approval or deny above", () => {
		for (const top of ["require-approval", "deny"] as const) {
			const chain = [level("root", top), level("child", "allow", [{ action: "allow" }])];
			expect(result(chain, op("exec", "ls"))).toBe(top);
			const ev = evaluate(chain, op("exec", "ls"));
			expect(ev.levels[1]).toMatchObject({ own: "allow", rule: 0, effective: top });
		}
	});

	it("a sub-level can tighten allow to require-approval or deny", () => {
		expect(result([level("r", "allow"), level("c", "require-approval")], op("exec", "x"))).toBe("require-approval");
		expect(result([level("r", "allow"), level("c", "deny")], op("exec", "x"))).toBe("deny");
		expect(result([level("r", "require-approval"), level("c", "deny")], op("exec", "x"))).toBe("deny");
		expect(result([level("r", "deny"), level("c", "require-approval")], op("exec", "x"))).toBe("deny");
	});

	it("sub-levels can whitelist with default deny plus allow rules", () => {
		const chain = [
			level("root", "allow"),
			level("child", "deny", [{ action: "allow", method: "exec", prefix: "systemctl status " }]),
		];
		expect(result(chain, op("exec", "systemctl status nginx"))).toBe("allow");
		expect(result(chain, op("exec", "systemctl restart nginx"))).toBe("deny");
		expect(result(chain, op("file.read", "/etc/passwd"))).toBe("deny");
	});

	it("worked example: root allows status, sub-level allows restart, so restart needs approval", () => {
		const root = level("root", "require-approval", [{ action: "allow", method: "exec", prefix: "systemctl status " }]);
		const sub = level("sub", "deny", [{ action: "allow", method: "exec", prefix: "systemctl restart " }]);
		const chain = [root, sub];
		// Status: root allows, but the sub-level's default denies it.
		expect(result(chain, op("exec", "systemctl status nginx"))).toBe("deny");
		// Restart: root asks for approval; the sub-level's allow cannot loosen it.
		const ev = evaluate(chain, op("exec", "systemctl restart nginx"));
		expect(ev.result).toBe("require-approval");
		expect(ev.levels[0]).toMatchObject({ own: "require-approval", effective: "require-approval" });
		expect(ev.levels[0]?.rule).toBeUndefined();
		expect(ev.levels[1]).toMatchObject({ own: "allow", rule: 0, effective: "require-approval" });
		// With a sub-level that inherits, restart still needs approval and status passes.
		const inheriting = [root, level("sub", "inherit", [{ action: "allow", prefix: "systemctl restart " }])];
		expect(result(inheriting, op("exec", "systemctl restart nginx"))).toBe("require-approval");
		expect(result(inheriting, op("exec", "systemctl status nginx"))).toBe("allow");
	});

	it("three-level chain: effective results are the running strictest", () => {
		const chain = [
			level("root", "allow", [{ action: "require-approval", method: "file.write", prefix: "/etc/" }]),
			level("mid", "inherit", [{ action: "deny", method: "file.write", prefix: "/etc/crha/" }]),
			level("leaf", "require-approval", [{ action: "allow", method: "exec", prefix: "uptime" }]),
		];
		const eff = (o: Operation) => evaluate(chain, o).levels.map((l) => l.effective);
		expect(eff(op("exec", "uptime"))).toEqual(["allow", "allow", "allow"]);
		expect(eff(op("exec", "ls"))).toEqual(["allow", "allow", "require-approval"]);
		expect(eff(op("file.write", "/etc/hosts"))).toEqual(["require-approval", "require-approval", "require-approval"]);
		expect(eff(op("file.write", "/etc/crha/x"))).toEqual(["require-approval", "deny", "deny"]);
		expect(eff(op("file.write", "/tmp/x"))).toEqual(["allow", "allow", "require-approval"]);
		const ev = evaluate(chain, op("file.write", "/etc/crha/x"));
		expect(ev.levels.map((l) => l.own)).toEqual(["require-approval", "deny", "require-approval"]);
		expect(ev.levels.map((l) => l.rule)).toEqual([0, 0, undefined]);
		expect(ev.levels.map((l) => l.scope.id)).toEqual(["root", "mid", "leaf"]);
		expect(ev.result).toBe("deny");
	});

	it("node-scoped rules only apply to the matching nodes", () => {
		const chain = [
			level("root", "allow", [{ action: "deny", nodes: ["group:prod"], method: "file.write", prefix: "/etc/crha/" }]),
		];
		expect(result(chain, op("file.write", "/etc/crha/x"))).toBe("deny");
		expect(result(chain, op("file.write", "/etc/crha/x", { id: "n2", name: "dev-1", groups: ["dev"] }))).toBe("allow");
		// deny file.write does not hide the file from reads
		expect(result(chain, op("file.read", "/etc/crha/x"))).toBe("allow");
	});
});

describe("presetRuleSet", () => {
	const methods: Method[] = ["exec", "file.read", "file.write"];
	const table: [Preset, Method, Action][] = [
		["ask", "exec", "require-approval"],
		["ask", "file.read", "allow"],
		["ask", "file.write", "require-approval"],
		["auto_review", "exec", "require-approval"],
		["auto_review", "file.read", "allow"],
		["auto_review", "file.write", "require-approval"],
		["yolo", "exec", "allow"],
		["yolo", "file.read", "allow"],
		["yolo", "file.write", "allow"],
	];

	it.each(table)("%s + %s -> %s", (preset, method, expected) => {
		expect(result([{ scope: { type: "session", id: "r" }, set: presetRuleSet(preset) }], op(method, "/any"))).toBe(
			expected,
		);
	});

	it("covers every method for every preset", () => {
		expect(table).toHaveLength(3 * methods.length);
	});

	it("has the documented shape", () => {
		expect(presetRuleSet("yolo")).toEqual({ default: "allow", rules: [] });
		for (const p of ["ask", "auto_review"] as const) {
			expect(presetRuleSet(p)).toEqual({
				default: "require-approval",
				rules: [{ action: "allow", method: "file.read", privileged: false }],
			});
		}
	});

	it("ask and auto review let ordinary reads pass but never a privileged task (D86)", () => {
		for (const p of ["ask", "auto_review"] as const) {
			const chain = [{ scope: { type: "session", id: "r" }, set: presetRuleSet(p) }];
			expect(result(chain, op("file.read", "/etc/hosts", NODE, true))).toBe("require-approval");
			expect(result(chain, op("file.read", "/etc/hosts"))).toBe("allow");
			expect(result(chain, op("file.write", "/etc/hosts", NODE, true))).toBe("require-approval");
			expect(result(chain, op("exec", "uptime", NODE, true))).toBe("require-approval");
		}
		// Yolo allows everything, privileged or not.
		const yolo = [{ scope: { type: "session", id: "r" }, set: presetRuleSet("yolo") }];
		expect(result(yolo, op("exec", "uptime", NODE, true))).toBe("allow");
	});

	it("user rules appended to a preset can tighten or extend it", () => {
		const set = presetRuleSet("ask");
		set.rules.push({ action: "allow", method: "exec", nodes: ["web-1"], prefix: "systemctl status " });
		set.rules.push({ action: "deny", method: "file.read", prefix: "/etc/shadow" });
		const chain = [{ scope: { type: "session", id: "r" }, set }];
		expect(result(chain, op("exec", "systemctl status nginx"))).toBe("allow");
		expect(result(chain, op("exec", "systemctl restart nginx"))).toBe("require-approval");
		expect(result(chain, op("file.read", "/etc/shadow"))).toBe("deny");
		expect(result(chain, op("file.read", "/etc/hosts"))).toBe("allow");
	});

	it("returns a fresh object each time", () => {
		const a = presetRuleSet("ask");
		a.rules.push({ action: "deny" });
		expect(presetRuleSet("ask").rules).toHaveLength(1);
	});
});

describe("operationOf", () => {
	it("renders the shared M4 targets (test/interop/m4_authz_cases.json)", () => {
		const fixture = JSON.parse(
			readFileSync(new URL("../../test/interop/m4_authz_cases.json", import.meta.url), "utf8"),
		) as {
			targets: { spec: unknown; method: string; target: string }[];
		};
		for (const { spec, method, target } of fixture.targets) {
			expect(operationOf(taskSpecFromJson(spec))).toEqual({ method, target });
		}
	});

	const exec = (init: { argv?: string[]; shell?: string }): TaskSpec => ({
		kind: "exec",
		command: init.argv !== undefined ? { argv: init.argv } : { shell: init.shell ?? "" },
		env: {},
		cwd: "",
		stdin: null,
	});

	it("joins plain argv with spaces", () => {
		expect(operationOf(exec({ argv: ["systemctl", "status", "nginx"] }))).toEqual({
			method: "exec",
			target: "systemctl status nginx",
		});
	});

	it("single-quotes args with characters outside the safe set", () => {
		const cases: [string[], string][] = [
			[["echo", "hello world"], "echo 'hello world'"],
			[["echo", "it's"], `echo 'it'\\''s'`],
			[["echo", ""], "echo ''"],
			[["echo", "a;b"], "echo 'a;b'"],
			[["echo", "$HOME"], "echo '$HOME'"],
			[["ls", "/tmp/a-b_c.d,e:f=g+h%i@j"], "ls /tmp/a-b_c.d,e:f=g+h%i@j"],
		];
		for (const [argv, target] of cases) expect(operationOf(exec({ argv })).target).toBe(target);
	});

	it("renders shell mode as /bin/sh -c <script>", () => {
		expect(operationOf(exec({ shell: "systemctl restart nginx; rm -rf /" }))).toEqual({
			method: "exec",
			target: "/bin/sh -c 'systemctl restart nginx; rm -rf /'",
		});
	});

	it("a prefix rule for an argv command does not match a shell-mode task", () => {
		const rule: Rule = { action: "allow", method: "exec", prefix: "systemctl restart " };
		const shell = operationOf(exec({ shell: "systemctl restart nginx; rm -rf /" }));
		expect(ruleMatches(rule, { ...shell, node: NODE, privileged: false })).toBe(false);
		const argv = operationOf(exec({ argv: ["systemctl", "restart", "nginx"] }));
		expect(ruleMatches(rule, { ...argv, node: NODE, privileged: false })).toBe(true);
	});

	it("an argv with a hostile argument stays one word", () => {
		const rule: Rule = { action: "allow", prefix: "systemctl restart " };
		const o = operationOf(exec({ argv: ["systemctl", "restart", "nginx; rm -rf /"] }));
		expect(o.target).toBe("systemctl restart 'nginx; rm -rf /'");
		expect(ruleMatches(rule, { ...o, node: NODE, privileged: false })).toBe(true);
	});

	it("maps file kinds to methods", () => {
		const path = "/etc/hosts";
		const empty = { size: 0, sha256: new Uint8Array(32) };
		const specs: [TaskSpec, Method][] = [
			[{ kind: "file.read", path, offset: 0, limit: 0 }, "file.read"],
			[{ kind: "file.stat", path }, "file.read"],
			[{ kind: "file.list", path, limit: 0 }, "file.read"],
			[{ kind: "file.write", path, content: empty, overwrite: true, mode: 0, owner: "", group: "" }, "file.write"],
			[{ kind: "file.edit", path, edits: [{ oldText: "a", newText: "b" }] }, "file.write"],
		];
		for (const [spec, method] of specs) {
			expect(operationOf(spec)).toEqual({ method, target: path });
		}
	});

	it("normalizes file paths", () => {
		const read = (path: string) => operationOf({ kind: "file.stat", path }).target;
		expect(read("/etc/nginx/../shadow")).toBe("/etc/shadow");
		expect(read("/etc//nginx/./nginx.conf")).toBe("/etc/nginx/nginx.conf");
		expect(read("/etc/nginx/")).toBe("/etc/nginx/");
	});

	it("path traversal cannot escape a prefix rule", () => {
		const rule: Rule = { action: "allow", method: "file.write", prefix: "/srv/app/" };
		const o = operationOf({
			kind: "file.write",
			path: "/srv/app/../../etc/passwd",
			content: { size: 0, sha256: new Uint8Array(32) },
			overwrite: true,
			mode: 0,
			owner: "",
			group: "",
		});
		expect(o.target).toBe("/etc/passwd");
		expect(ruleMatches(rule, { ...o, node: NODE, privileged: false })).toBe(false);
	});

	it("throws for a spec without a kind", () => {
		expect(() => operationOf({} as TaskSpec)).toThrow();
	});
});

describe("parseRuleSet", () => {
	const bad = (raw: unknown, root: boolean) => expect(() => parseRuleSet(raw, root)).toThrow(UserError);

	it("accepts a full root set", () => {
		const raw = {
			default: "require-approval",
			rules: [
				{ action: "deny", method: "file.write", nodes: ["group:prod"], prefix: "/etc/crha/" },
				{ action: "allow", method: "exec", exact: "uptime", privileged: true },
				{ action: "allow", privileged: false },
				{ action: "allow" },
			],
		};
		expect(parseRuleSet(raw, true)).toEqual(raw);
	});

	it("root needs an explicit default that is not inherit", () => {
		bad({}, true);
		bad({ rules: [] }, true);
		bad({ default: "inherit" }, true);
		bad({ default: "bogus" }, true);
		bad({ default: 1 }, true);
		for (const d of ["allow", "deny", "require-approval"]) expect(parseRuleSet({ default: d }, true).default).toBe(d);
	});

	it("non-root default defaults to inherit and accepts inherit", () => {
		expect(parseRuleSet({}, false)).toEqual({ default: "inherit", rules: [] });
		expect(parseRuleSet({ default: "inherit" }, false).default).toBe("inherit");
		expect(parseRuleSet({ default: "deny", rules: [] }, false).default).toBe("deny");
		bad({ default: "nope" }, false);
	});

	it("rejects non-objects", () => {
		for (const raw of [null, undefined, 1, "x", []]) bad(raw, false);
		bad({ default: "allow", rules: "x" }, true);
		bad({ default: "allow", rules: ["x"] }, true);
		bad({ default: "allow", rules: [[]] }, true);
		bad({ default: "allow", rules: [null] }, true);
	});

	it("rejects unknown fields, including regex", () => {
		bad({ default: "allow", rules: [{ action: "allow", regex: "^a" }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", foo: 1 }] }, true);
	});

	it("rejects a bad or missing action and a bad method", () => {
		bad({ default: "allow", rules: [{}] }, true);
		bad({ default: "allow", rules: [{ action: "inherit" }] }, true);
		bad({ default: "allow", rules: [{ action: "permit" }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", method: "file.read.x" }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", method: "file.stat" }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", method: 3 }] }, true);
	});

	it("rejects a non-boolean privileged flag", () => {
		bad({ default: "allow", rules: [{ action: "allow", privileged: "true" }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", privileged: 1 }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", privileged: null }] }, true);
		expect(parseRuleSet({ default: "allow", rules: [{ action: "allow", privileged: true }] }, true).rules[0]).toEqual({
			action: "allow",
			privileged: true,
		});
		expect(parseRuleSet({ default: "allow", rules: [{ action: "allow", privileged: false }] }, true).rules[0]).toEqual({
			action: "allow",
			privileged: false,
		});
	});

	it("rejects bad nodes lists", () => {
		bad({ default: "allow", rules: [{ action: "allow", nodes: [] }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", nodes: "web-1" }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", nodes: [""] }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", nodes: [1] }] }, true);
	});

	it("rejects exact and prefix together, and non-string or over-long patterns", () => {
		bad({ default: "allow", rules: [{ action: "allow", exact: "a", prefix: "b" }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", prefix: 1 }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", exact: "x".repeat(1001) }] }, true);
		bad({ default: "allow", rules: [{ action: "allow", prefix: "x".repeat(1001) }] }, true);
		const ok = parseRuleSet({ default: "allow", rules: [{ action: "allow", prefix: "x".repeat(1000) }] }, true);
		expect(ok.rules[0]?.prefix).toHaveLength(1000);
	});

	it("allows at most 200 rules", () => {
		const rules = (n: number) => Array.from({ length: n }, () => ({ action: "allow" }));
		expect(parseRuleSet({ default: "deny", rules: rules(200) }, true).rules).toHaveLength(200);
		bad({ default: "deny", rules: rules(201) }, true);
	});

	it("reports which rule is wrong", () => {
		expect(() => parseRuleSet({ default: "allow", rules: [{ action: "allow" }, { action: "x" }] }, true)).toThrow(
			/rule 2/,
		);
	});

	it("the parser's output is accepted by evaluate", () => {
		const root = parseRuleSet({ default: "deny", rules: [{ action: "allow", prefix: "ls" }] }, true);
		const sub = parseRuleSet({}, false);
		const chain: ChainLevel[] = [
			{ scope: { type: "session", id: "r" }, set: root },
			{ scope: { type: "session", id: "c" }, set: sub },
		];
		expect(result(chain, op("exec", "ls -l"))).toBe("allow");
		expect(result(chain, op("exec", "rm x"))).toBe("deny");
	});
});
