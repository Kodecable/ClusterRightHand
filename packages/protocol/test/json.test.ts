import { describe, expect, it } from "vitest";
import {
	factsFromJson,
	factsToJson,
	JsonError,
	type JsonTaskSpec,
	taskSpecFromJson,
	taskSpecToJson,
} from "../src/json.ts";
import type { Facts, TaskSpec } from "../src/messages.ts";

const digest = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const facts: Facts = {
	hostname: "node-1",
	osId: "ubuntu",
	osVersionId: "24.04",
	osPrettyName: "Ubuntu 24.04 LTS",
	kernel: "6.8.0",
	arch: "x86_64",
	initSystem: "systemd",
	packageManagers: ["apt", "snap"],
	privilegeTools: ["sudo"],
	notesPath: "/etc/notes",
	groups: ["sudo"],
	clockOffsetMs: -1234,
};

const specs: TaskSpec[] = [
	{
		kind: "exec",
		command: { argv: ["ls", "-l"] },
		env: { B: "2", A: "1" },
		cwd: "/tmp/数据",
		stdin: null,
	},
	{
		kind: "exec",
		command: { shell: "ls | wc -l" },
		env: {},
		cwd: "",
		stdin: { size: 3, sha256: digest(0xab) },
	},
	{ kind: "file.read", path: "/etc/hosts", offset: 0, limit: 0 },
	{
		kind: "file.write",
		path: "/tmp/x",
		content: { size: 3, sha256: digest(0xcd) },
		overwrite: false,
		mode: 0o644,
		owner: "",
		group: "",
	},
	{
		kind: "file.edit",
		path: "/tmp/x",
		edits: [
			{ oldText: "a", newText: "b" },
			{ oldText: "你好", newText: "世界" },
		],
	},
	{ kind: "file.stat", path: "/tmp/x" },
	{ kind: "file.list", path: "/tmp", limit: 0 },
];

describe("JSON forms", () => {
	it.each(specs)("round-trips TaskSpec $kind", (spec) => {
		const json = taskSpecToJson(spec);
		expect(taskSpecFromJson(json)).toEqual(spec);
		expect(taskSpecFromJson(JSON.parse(JSON.stringify(json)))).toEqual(spec);
	});

	it("encodes sha256 as lowercase hex", () => {
		const json = taskSpecToJson(specs[1] as TaskSpec);
		if (json.kind !== "exec" || json.stdin === null) throw new Error("unexpected shape");
		expect(json.stdin.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(json.stdin.sha256).toBe("ab".repeat(32));
	});

	it("round-trips Facts", () => {
		const json = factsToJson(facts);
		expect(factsFromJson(json)).toEqual(facts);
		expect(factsFromJson(JSON.parse(JSON.stringify(json)))).toEqual(facts);
	});

	const execJson: JsonTaskSpec = {
		kind: "exec",
		command: { argv: ["ls"] },
		env: {},
		cwd: "",
		stdin: null,
	};

	const badSpecs: [string, unknown][] = [
		["unknown kind", { kind: "bogus", path: "/" }],
		["missing kind", { path: "/" }],
		["non-object", []],
		["null", null],
		["exec missing cwd", { kind: "exec", command: { argv: [] }, env: {}, stdin: null }],
		["exec extra field", { ...execJson, extra: 1 }],
		["command with both argv and shell", { ...execJson, command: { argv: [], shell: "" } }],
		["command with neither argv nor shell", { ...execJson, command: {} }],
		["bad env value", { ...execJson, env: { A: 1 } }],
		["bad stdin", { ...execJson, stdin: {} }],
		[
			"uppercase sha256",
			{
				kind: "file.write",
				path: "",
				content: { size: 0, sha256: "AA".repeat(32) },
				overwrite: false,
				mode: 0,
				owner: "",
				group: "",
			},
		],
		[
			"short sha256",
			{
				kind: "file.write",
				path: "",
				content: { size: 0, sha256: "a".repeat(63) },
				overwrite: false,
				mode: 0,
				owner: "",
				group: "",
			},
		],
		[
			"non-hex sha256",
			{
				kind: "file.write",
				path: "",
				content: { size: 0, sha256: "g".repeat(64) },
				overwrite: false,
				mode: 0,
				owner: "",
				group: "",
			},
		],
		["negative offset", { kind: "file.read", path: "/", offset: -1, limit: 0 }],
		["float limit", { kind: "file.read", path: "/", offset: 0, limit: 1.5 }],
		["unsafe uint", { kind: "file.read", path: "/", offset: 0, limit: 2 ** 53 }],
		["edits not an array", { kind: "file.edit", path: "/", edits: {} }],
		["edit missing newText", { kind: "file.edit", path: "/", edits: [{ oldText: "a" }] }],
		["file.stat extra field", { kind: "file.stat", path: "/", extra: 1 }],
		["file.write missing content", { kind: "file.write", path: "/", overwrite: false, mode: 0, owner: "", group: "" }],
	];

	it.each(badSpecs)("rejects bad TaskSpec: %s", (_name, value) => {
		expect(() => taskSpecFromJson(value)).toThrow(JsonError);
	});

	const factsJson = factsToJson(facts);
	const withoutHostname = Object.fromEntries(Object.entries(factsJson).filter(([key]) => key !== "hostname"));
	const badFacts: [string, unknown][] = [
		["missing hostname", withoutHostname],
		["extra field", { ...factsJson, extra: 1 }],
		["bad groups", { ...factsJson, groups: "sudo" }],
		["bad group item", { ...factsJson, groups: ["sudo", 1] }],
		["float clock offset", { ...factsJson, clockOffsetMs: 1.5 }],
		["non-object", "facts"],
	];

	it.each(badFacts)("rejects bad Facts: %s", (_name, value) => {
		expect(() => factsFromJson(value)).toThrow(JsonError);
	});
});
