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
	clockOffsetMs: -1234,
	shells: { sh: "/bin/sh", bash: "/usr/bin/bash" },
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
	{ kind: "file.read", path: "/etc/hosts", startLine: 1, lineCount: 100 },
	{
		kind: "file.write",
		path: "/tmp/x",
		content: { size: 3, sha256: digest(0xcd) },
		overwrite: false,
		mode: 0o644,
		owner: "",
		group: "",
		createParentDirs: true,
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
		["bad env key", { ...execJson, env: { "\ud800": "x" } }],
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
				createParentDirs: false,
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
				createParentDirs: false,
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
				createParentDirs: false,
			},
		],
		["negative start line", { kind: "file.read", path: "/", startLine: -1, lineCount: 1 }],
		["float line count", { kind: "file.read", path: "/", startLine: 1, lineCount: 1.5 }],
		["unsafe uint", { kind: "file.read", path: "/", startLine: 1, lineCount: 2 ** 53 }],
		["edits not an array", { kind: "file.edit", path: "/", edits: {} }],
		["edit missing newText", { kind: "file.edit", path: "/", edits: [{ oldText: "a" }] }],
		["file.stat extra field", { kind: "file.stat", path: "/", extra: 1 }],
		[
			"file.write missing content",
			{ kind: "file.write", path: "/", overwrite: false, mode: 0, owner: "", group: "", createParentDirs: false },
		],
		[
			"file.write missing createParentDirs",
			{
				kind: "file.write",
				path: "/",
				content: { size: 0, sha256: "0".repeat(64) },
				overwrite: false,
				mode: 0,
				owner: "",
				group: "",
			},
		],
	];

	it.each(badSpecs)("rejects bad TaskSpec: %s", (_name, value) => {
		expect(() => taskSpecFromJson(value)).toThrow(JsonError);
	});

	const factsJson = factsToJson(facts);
	const badFacts: [string, unknown][] = [
		["bad hostname", { ...factsJson, hostname: 1 }],
		["bad notes path", { ...factsJson, notesPath: 1 }],
		["float clock offset", { ...factsJson, clockOffsetMs: 1.5 }],
		["bad shells", { ...factsJson, shells: "bash" }],
		["bad shells.sh", { ...factsJson, shells: { sh: 1 } }],
		["bad shells.bash", { ...factsJson, shells: { sh: "/bin/sh", bash: 1 } }],
		["non-object", "facts"],
	];

	it.each(badFacts)("rejects bad Facts: %s", (_name, value) => {
		expect(() => factsFromJson(value)).toThrow(JsonError);
	});

	it("omits absent facts and keeps a missing shells.bash absent", () => {
		const minimal: Facts = { hostname: "node-1" };
		expect(factsToJson(minimal)).toEqual(minimal);
		const noBash: Facts = { ...facts, shells: { sh: "/bin/sh" } };
		expect(factsToJson(noBash)).toEqual({ ...factsJson, shells: { sh: "/bin/sh" } });
		expect(factsFromJson(factsToJson(noBash))).toEqual(noBash);
		// null is a valid spelling of "no bash" and round-trips through storage.
		const nullBash: Facts = { ...facts, shells: { sh: "/bin/sh", bash: null } };
		expect(factsFromJson(factsToJson(nullBash))).toEqual(nullBash);
	});

	it("reads partial stored rows: no shells, or shells only for an SSH node", () => {
		const { shells: _shells, osId: _osId, ...legacy } = factsJson;
		expect(factsFromJson(legacy)).toEqual(legacy);
		const ssh = { shells: { sh: "/bin/sh", bash: null } };
		expect(factsFromJson(ssh)).toEqual(ssh);
		// A legacy row with shells: null reads as no shells, and unknown keys are ignored.
		expect(factsFromJson({ ...legacy, shells: null })).toEqual(legacy);
		expect(factsFromJson({ ...factsJson, futureFact: "ignored" })).toEqual(factsJson);
	});
});
