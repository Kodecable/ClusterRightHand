import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CborError, decode as decodeCbor, encode as encodeCbor } from "../src/cbor.ts";
import {
	type Command,
	commandCodec,
	type Edit,
	type Enrollment,
	type ExecSpec,
	editCodec,
	emptyCodec,
	enrollmentCodec,
	errorCodec,
	execSpecCodec,
	type Facts,
	factsCodec,
	type HandshakeInit,
	type HandshakeResponse,
	type Hello,
	handshakeInitCodec,
	handshakeResponseCodec,
	helloCodec,
	type InputRef,
	inputRefCodec,
	isValidMetricsInterfaceName,
	MAX_METRICS_CORES,
	MAX_METRICS_DISKS,
	MAX_METRICS_INTERFACES,
	type MetricsSnapshot,
	metricsSnapshotCodec,
	type NodeStatus,
	nodeStatusCodec,
	type Outcome,
	type OutputAck,
	type OutputMode,
	outcomeCodec,
	outputAckCodec,
	outputModeCodec,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	PTY_EXIT_REASONS,
	PTY_NOISE_PROLOGUE_PREFIX,
	type PtyClose,
	type PtyExited,
	type PtyList,
	type PtyOpen,
	type PtyResize,
	type PtyStatus,
	pingCodec,
	ptyCloseCodec,
	ptyConnectionInitCodec,
	ptyConnectionResponseCodec,
	ptyExitedCodec,
	ptyListCodec,
	ptyOpenCodec,
	ptyResizeCodec,
	ptyStatusCodec,
	type TaskExit,
	type TaskInput,
	type TaskOutput,
	type TaskResult,
	type TaskSpec,
	type TaskStart,
	type TaskStatus,
	taskCancelCodec,
	taskExitAckCodec,
	taskExitCodec,
	taskInputCodec,
	taskOutputCodec,
	taskQueryCodec,
	taskResultCodec,
	taskSpecCodec,
	taskStartCodec,
	taskStatusCodec,
	type Welcome,
	welcomeCodec,
} from "../src/messages.ts";
import {
	COMMANDS,
	type CommandRequest,
	type CommandResponse,
	EVENTS,
	OPTIONAL_NAMES,
	offeredNames,
	REQUIRED_NAMES,
} from "../src/registry.ts";
import { type Codec, SchemaError } from "../src/schema.ts";

const digest = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

// The interface-name form shared with crha (doc/design/metrics.md "Limits"). The hex entries are names
// whose bytes are not valid UTF-8: JavaScript strings cannot hold those, so the decoder side of the
// profile is where the TypeScript rule can reject them.
const interfaceNameCases = JSON.parse(
	readFileSync(new URL("../../../test/interop/metrics_interface_names.json", import.meta.url), "utf8"),
) as { valid: string[]; invalid: string[]; invalid_utf8_hex: string[] };

const facts: Facts = {
	hostname: "node-1",
	platform: "linux, amd64, Ubuntu 24.04.4 LTS",
	hints: "Found systemd.\nPID 1 is systemd.\nFound apt.\nFound sudo.",
	notesPath: "/etc/notes",
	clockOffsetMs: -5,
	shells: { sh: "/bin/sh", bash: "/usr/bin/bash" },
};

const status: TaskStatus = { taskId: "t-1", state: "running", outputEnd: 10 };
const ack: OutputAck = { taskId: "t-1", offset: 10 };
const inputRef: InputRef = { size: 3, sha256: digest(0x11) };
const commandArgv: Command = { argv: ["echo", "hi"] };
const commandShell: Command = { shell: "echo hi" };
const execSpec: ExecSpec = { command: commandArgv, env: { A: "1", B: "2" }, cwd: "/tmp", stdin: null };
const execSpecStdin: ExecSpec = { command: commandShell, env: {}, cwd: "/tmp", stdin: inputRef };
const edit: Edit = { oldText: "a", newText: "b" };
const specExec: TaskSpec = { kind: "exec", ...execSpec };
const specRead: TaskSpec = { kind: "file.read", path: "/etc/hosts", startLine: 1, lineCount: 100 };
const specWrite: TaskSpec = {
	kind: "file.write",
	path: "/tmp/x",
	content: inputRef,
	overwrite: false,
	mode: 0,
	owner: "",
	group: "",
	createParentDirs: false,
};
const specEdit: TaskSpec = { kind: "file.edit", path: "/tmp/x", edits: [edit] };
const specStat: TaskSpec = { kind: "file.stat", path: "/tmp/x" };
const specList: TaskSpec = { kind: "file.list", path: "/tmp", limit: 0 };
const specPtyCreate: TaskSpec = { kind: "pty.create", argv: ["/bin/bash", "-l"] };
const outputFull: OutputMode = { kind: "full", spillBytes: 1024, spillLines: 10 };
const outputText: OutputMode = { kind: "text" };
const outputStatus: OutputMode = { kind: "status" };
const taskStart: TaskStart = {
	taskId: "t-1",
	attempt: 1,
	spec: specExec,
	privileged: false,
	authorizations: [Uint8Array.of(0x00, 0xff)],
	cosign: Uint8Array.of(0x01),
	timeoutMs: 1000,
	killGraceMs: 500,
	output: outputFull,
};
const outcomeCode: Outcome = { kind: "code", value: 0 };
const outcomeSignal: Outcome = { kind: "signal", value: "TERM" };
const outcomeError: Outcome = { kind: "error", code: "internal_error", message: "failed" };
const taskExit: TaskExit = {
	taskId: "t-1",
	outcome: outcomeCode,
	timedOut: false,
	cancelled: false,
	outputEnd: 6,
	outputFile: "",
	outputLines: 1,
	outputLost: false,
	result: null,
};
const readResult: TaskResult = { kind: "file.read", from: 1, to: 2, eof: true, total: 3, tooLong: false };
const statResult: TaskResult = {
	kind: "file.stat",
	path: "/tmp/x",
	type: "file",
	size: 7,
	mode: "0644",
	uid: 1000,
	gid: 1000,
	owner: "alice",
	group: "alice",
	mtime: "2026-01-01T00:00:00Z",
	linkTarget: null,
};
const listResult: TaskResult = {
	kind: "file.list",
	entries: [{ name: "f.txt", type: "file", size: 7, mode: "0644", mtime: "2026-01-01T00:00:00Z" }],
	truncated: false,
};
const writeResult: TaskResult = { kind: "file.write", bytes: 3, created: true };
const editResult: TaskResult = { kind: "file.edit", replacements: 2 };
const hello: Hello = { tasks: [status], taskKinds: ["exec"], privilegedMode: "disabled" };
const welcome: Welcome = { acks: [ack] };
const taskInput: TaskInput = { taskId: "t-1", offset: 0, data: Uint8Array.of(1, 2, 3) };
const taskOutput: TaskOutput = { taskId: "t-1", offset: 0, data: Uint8Array.of(4, 5) };
const nodeStatus: NodeStatus = { nodeId: "n-1", state: "active", message: "ok" };
const enrollment: Enrollment = { tokenSecret: "secret", hostname: "node-1", facts };
const handshakeInit: HandshakeInit = {
	protocolMajor: PROTOCOL_MAJOR,
	protocolMinor: PROTOCOL_MINOR,
	commands: [...REQUIRED_NAMES],
	crhaVersion: "0.1.0",
	clientTimeMs: 1_700_000_000_000,
	enroll: enrollment,
};
const handshakeResponse: HandshakeResponse = {
	protocolMajor: PROTOCOL_MAJOR,
	protocolMinor: PROTOCOL_MINOR,
	commands: [...REQUIRED_NAMES],
	connectionId: "conn-1",
	serverTimeMs: 1_700_000_000_000,
	nodeState: "active",
	nodeId: "n-1",
};

const ptyOpen: PtyOpen = {
	ptyId: "pty-1",
	argv: ["/bin/bash", "-l"],
	rows: 40,
	cols: 120,
	privileged: false,
	scrollbackBytes: 1048576,
	attempt: 0,
	authorizations: [],
	cosign: null,
};
const ptyResize: PtyResize = { ptyId: "pty-1", rows: 50, cols: 200 };
const ptyClose: PtyClose = { ptyId: "pty-1", reason: "manual" };
const ptyExited: PtyExited = { ptyId: "pty-2", exitCode: -1, reason: "helper_lost" };
const ptyStatus: PtyStatus = { ptyId: "pty-1", exited: false, exitCode: 0 };
const ptyList: PtyList = {
	terminals: [ptyStatus, { ptyId: "pty-2", exited: true, exitCode: 137 }],
};
const ptyConnectionInit = { protocolMajor: PROTOCOL_MAJOR, ptyId: "pty-1", inputReceived: 1024 };
const ptyConnectionResponse = { protocolMajor: PROTOCOL_MAJOR, outputReceived: 2048 };

const metricsSnapshot: MetricsSnapshot = {
	bootId: "6f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b",
	uptimeSec: 123456,
	cpu: {
		total: { busy: 123456789n, total: 234567890n },
		cores: [
			{ index: 0, busy: 111n, total: 222n },
			// A jiffy counter above 2^53 needs the 64-bit form (doc/design/protocol.md "Encoding rules").
			{ index: 2, busy: 9007199254740993n, total: 9007199254740995n },
		],
	},
	loads: { l1: 1230, l5: 2450, l15: 3780 },
	memory: {
		totalBytes: 16777216000n,
		availableBytes: 8388608000n,
		cachedBytes: 4294967296n,
		freeBytes: 2147483648n,
	},
	swap: { totalBytes: 2147483648n, freeBytes: 1073741824n },
	disks: [
		{ kind: "ok", name: "root", path: "/", totalBytes: 107374182400n, usedBytes: 53687091200n },
		{ kind: "error", name: "data", path: "/data", error: "statfs timed out" },
	],
	interfaces: [
		{
			name: "eth0",
			rxBytes: 9007199254740993n,
			txBytes: 1234567890123n,
			rxPackets: 987654321n,
			txPackets: 123456789n,
		},
	],
};

function asCase<T>(name: string, codec: Codec<T>, value: T): [string, Codec<unknown>, unknown] {
	return [name, codec as Codec<unknown>, value];
}

const cases: [string, Codec<unknown>, unknown][] = [
	asCase("Facts", factsCodec, facts),
	asCase("Enrollment", enrollmentCodec, enrollment),
	asCase("HandshakeInit", handshakeInitCodec, handshakeInit),
	asCase("HandshakeInit without enroll", handshakeInitCodec, { ...handshakeInit, enroll: null }),
	asCase("HandshakeResponse", handshakeResponseCodec, handshakeResponse),
	asCase("Error", errorCodec, { code: "internal_error", message: "failed" }),
	asCase("OutputAck", outputAckCodec, ack),
	asCase("TaskStatus", taskStatusCodec, status),
	asCase("InputRef", inputRefCodec, inputRef),
	asCase("Command argv", commandCodec, commandArgv),
	asCase("Command shell", commandCodec, commandShell),
	asCase("ExecSpec", execSpecCodec, execSpec),
	asCase("ExecSpec with stdin", execSpecCodec, execSpecStdin),
	asCase("Edit", editCodec, edit),
	asCase("TaskSpec exec", taskSpecCodec, specExec),
	asCase("TaskSpec file.read", taskSpecCodec, specRead),
	asCase("TaskSpec file.write", taskSpecCodec, specWrite),
	asCase("TaskSpec file.edit", taskSpecCodec, specEdit),
	asCase("TaskSpec file.stat", taskSpecCodec, specStat),
	asCase("TaskSpec file.list", taskSpecCodec, specList),
	asCase("TaskSpec pty.create", taskSpecCodec, specPtyCreate),
	asCase("TaskSpec pty.create login shell", taskSpecCodec, { kind: "pty.create", argv: [] }),
	asCase("OutputMode full", outputModeCodec, outputFull),
	asCase("OutputMode text", outputModeCodec, outputText),
	asCase("OutputMode status", outputModeCodec, outputStatus),
	asCase("TaskStart", taskStartCodec, taskStart),
	asCase("Outcome code", outcomeCodec, outcomeCode),
	asCase("Outcome signal", outcomeCodec, outcomeSignal),
	asCase("Outcome error", outcomeCodec, outcomeError),
	asCase("TaskResult file.read", taskResultCodec, readResult),
	asCase("TaskResult file.stat", taskResultCodec, statResult),
	asCase("TaskResult file.list", taskResultCodec, listResult),
	asCase("TaskResult file.write", taskResultCodec, writeResult),
	asCase("TaskResult file.edit", taskResultCodec, editResult),
	asCase("TaskResult file.read without a total", taskResultCodec, { ...readResult, eof: false, total: null }),
	asCase("TaskResult file.stat of a symlink", taskResultCodec, {
		...statResult,
		type: "symlink",
		linkTarget: "/tmp/y",
	}),
	asCase("TaskExit", taskExitCodec, taskExit),
	asCase("TaskExit with lost output", taskExitCodec, { ...taskExit, outputLost: true }),
	asCase("TaskExit with a result", taskExitCodec, { ...taskExit, result: readResult }),
	asCase("Hello", helloCodec, hello),
	asCase("Welcome", welcomeCodec, welcome),
	asCase("ping", pingCodec, { seq: 42 }),
	asCase("TaskInput", taskInputCodec, taskInput),
	asCase("TaskCancel", taskCancelCodec, { taskId: "t-1" }),
	asCase("TaskQuery", taskQueryCodec, { taskId: "t-1" }),
	asCase("empty", emptyCodec, {}),
	asCase("TaskOutput", taskOutputCodec, taskOutput),
	asCase("NodeStatus", nodeStatusCodec, nodeStatus),
	asCase("TaskExitAck", taskExitAckCodec, { taskId: "t-1" }),
	asCase("PTY open", ptyOpenCodec, ptyOpen),
	asCase("PTY resize", ptyResizeCodec, ptyResize),
	asCase("PTY close", ptyCloseCodec, ptyClose),
	asCase("PTY exited", ptyExitedCodec, ptyExited),
	asCase("PTY status", ptyStatusCodec, ptyStatus),
	asCase("PTY list", ptyListCodec, ptyList),
	asCase("PTY connection init", ptyConnectionInitCodec, ptyConnectionInit),
	asCase("PTY connection response", ptyConnectionResponseCodec, ptyConnectionResponse),
	asCase("Metrics snapshot", metricsSnapshotCodec, metricsSnapshot),
	asCase("Metrics snapshot with only the boot id", metricsSnapshotCodec, { bootId: "boot-1" }),
	asCase("Metrics snapshot with empty lists", metricsSnapshotCodec, { disks: [], interfaces: [] }),
];

describe("message codecs", () => {
	it.each(cases)("round-trips %s", (_name, codec, value) => {
		const encoded = encodeCbor(codec.encode(value));
		const decoded = codec.decode(decodeCbor(encoded));
		expect(decoded).toEqual(value);
		expect(Buffer.from(encodeCbor(codec.encode(decoded))).toString("hex")).toBe(Buffer.from(encoded).toString("hex"));
	});

	it("encodes Facts as a snake_case map and omits absent facts", () => {
		const encoded = decodeCbor(encodeCbor(factsCodec.encode(facts))) as Map<string, unknown>;
		expect(encoded).toBeInstanceOf(Map);
		expect([...encoded.keys()].sort()).toEqual([
			"clock_offset_ms",
			"hints",
			"hostname",
			"notes_path",
			"platform",
			"shells",
		]);
		expect(encoded.get("shells")).toEqual(
			new Map([
				["sh", "/bin/sh"],
				["bash", "/usr/bin/bash"],
			]),
		);
		const minimal: Facts = { hostname: "node-1" };
		const minimalWire = decodeCbor(encodeCbor(factsCodec.encode(minimal))) as Map<string, unknown>;
		expect([...minimalWire.keys()].sort()).toEqual(["hostname"]);
		expect(factsCodec.decode(minimalWire)).toEqual(minimal);
	});

	it("omits shells.bash when there is none, and accepts bash: null", () => {
		for (const shells of [{ sh: "/bin/sh" }, { sh: "/bin/sh", bash: null }]) {
			const wire = encodeCbor(factsCodec.encode({ ...facts, shells }));
			const decodedShells = (decodeCbor(wire) as Map<string, unknown>).get("shells") as Map<string, unknown>;
			expect(decodedShells.has("bash")).toBe(false);
			expect(factsCodec.decode(decodeCbor(wire))).toEqual({ ...facts, shells: { sh: "/bin/sh" } });
		}
		// bash: null is accepted on decode too (doc/design/protocol.md "Events").
		const nullBash = new Map<string, unknown>([
			["hostname", "node-1"],
			[
				"shells",
				new Map<string, unknown>([
					["sh", "/bin/sh"],
					["bash", null],
				]),
			],
		]);
		expect(factsCodec.decode(nullBash)).toEqual({
			hostname: "node-1",
			shells: { sh: "/bin/sh", bash: null },
		});
	});

	it("ignores unknown Facts keys and rejects missing or mistyped ones", () => {
		const accepted = new Map<string, unknown>([
			["hostname", "node-1"],
			["future_fact", "ignored"],
			[
				"shells",
				new Map<string, unknown>([
					["sh", "/bin/sh"],
					["zsh", "/usr/bin/zsh"],
				]),
			],
		]);
		expect(factsCodec.decode(accepted)).toEqual({ hostname: "node-1", shells: { sh: "/bin/sh" } });
		for (const bad of [
			new Map<string, unknown>([["groups", []]]),
			new Map<string, unknown>([["hostname", 1]]),
			new Map<string, unknown>([
				["hostname", "node-1"],
				["platform", 1],
			]),
			new Map<string, unknown>([
				["hostname", "node-1"],
				["clock_offset_ms", "0"],
			]),
			new Map<string, unknown>([
				["hostname", "node-1"],
				["shells", new Map<string, unknown>([["bash", "/bin/bash"]])],
			]),
			[],
		]) {
			expect(() => factsCodec.decode(bad)).toThrow(SchemaError);
		}
	});

	it("rejects a non-text Facts key, also inside shells", () => {
		const factsWithIntegerKey = new Map<unknown, unknown>([
			["hostname", "node-1"],
			[1, "x"],
		]);
		expect(() => factsCodec.decode(factsWithIntegerKey)).toThrow(SchemaError);
		const shellsWithIntegerKey = new Map<unknown, unknown>([
			["hostname", "node-1"],
			[
				"shells",
				new Map<unknown, unknown>([
					["sh", "/bin/sh"],
					[1, "x"],
				]),
			],
		]);
		expect(() => factsCodec.decode(shellsWithIntegerKey)).toThrow(SchemaError);
	});

	it("encodes the metrics snapshot as a snake_case map and omits absent sources", () => {
		const wire = decodeCbor(encodeCbor(metricsSnapshotCodec.encode(metricsSnapshot))) as Map<string, unknown>;
		expect([...wire.keys()].sort()).toEqual([
			"boot_id",
			"cpu",
			"disks",
			"interfaces",
			"loads",
			"memory",
			"swap",
			"uptime_sec",
		]);
		// The CPU field is the total pair followed by the core triples.
		// A safe uint decodes as a number; only a counter above 2^53-1 stays a bigint.
		expect(wire.get("cpu")).toEqual([
			[123456789, 234567890],
			[
				[0, 111, 222],
				[2, 9007199254740993n, 9007199254740995n],
			],
		]);
		expect(metricsSnapshotCodec.decode(wire)).toEqual(metricsSnapshot);
		const minimal = metricsSnapshotCodec.encode({});
		expect([...(decodeCbor(encodeCbor(minimal)) as Map<string, unknown>).keys()]).toEqual([]);
		expect(metricsSnapshotCodec.decode(new Map())).toEqual({});
	});

	it("normalizes small metrics counters to bigint", () => {
		// cborg decodes a small uint as a number; the codec gives every counter the same bigint type.
		const wire = new Map<string, unknown>([
			["uptime_sec", 5],
			["swap", [1, 2]],
		]);
		expect(metricsSnapshotCodec.decode(wire)).toEqual({
			uptimeSec: 5,
			swap: { totalBytes: 1n, freeBytes: 2n },
		});
	});

	it("ignores unknown metrics keys and rejects null or mistyped ones", () => {
		const accepted = new Map<string, unknown>(metricsSnapshotCodec.encode(metricsSnapshot) as Map<string, unknown>);
		accepted.set("future_metric", 1);
		expect(metricsSnapshotCodec.decode(accepted)).toEqual(metricsSnapshot);
		expect(() => metricsSnapshotCodec.decode(new Map([["boot_id", null]]))).toThrow(SchemaError);
		expect(() => metricsSnapshotCodec.decode(new Map([["uptime_sec", -1]]))).toThrow(SchemaError);
		expect(() => metricsSnapshotCodec.decode(new Map([["loads", [1, 2]]]))).toThrow(SchemaError);
		expect(() => metricsSnapshotCodec.decode(new Map([["swap", [1n, 2n ** 64n]]]))).toThrow(SchemaError);
		const nonTextKey = new Map<unknown, unknown>([
			["boot_id", "boot-1"],
			[1, "x"],
		]);
		expect(() => metricsSnapshotCodec.decode(nonTextKey)).toThrow(SchemaError);
	});

	it("truncates before sending and rejects more than the metrics limits", () => {
		const core = { index: 0, busy: 1n, total: 2n };
		const total = { busy: 1n, total: 2n };
		expect(MAX_METRICS_CORES).toBe(1024);
		expect(MAX_METRICS_DISKS).toBe(64);
		expect(MAX_METRICS_INTERFACES).toBe(256);
		expect(() =>
			metricsSnapshotCodec.encode({ cpu: { total, cores: Array(MAX_METRICS_CORES + 1).fill(core) } }),
		).toThrow(SchemaError);
		expect(() =>
			metricsSnapshotCodec.encode({ disks: Array(MAX_METRICS_DISKS + 1).fill(metricsSnapshot.disks?.[0]) }),
		).toThrow(SchemaError);
		expect(() =>
			metricsSnapshotCodec.encode({
				interfaces: Array(MAX_METRICS_INTERFACES + 1).fill(metricsSnapshot.interfaces?.[0]),
			}),
		).toThrow(SchemaError);
		expect(() =>
			metricsSnapshotCodec.decode(new Map([["disks", Array(MAX_METRICS_DISKS + 1).fill(["ok", ["d", "/d", 1n, 2n]])]])),
		).toThrow(SchemaError);
		expect(() =>
			metricsSnapshotCodec.decode(
				new Map([["interfaces", Array(MAX_METRICS_INTERFACES + 1).fill(["eth0", 1n, 2n, 3n, 4n])]]),
			),
		).toThrow(SchemaError);
		expect(() =>
			metricsSnapshotCodec.decode(new Map([["cpu", [[1n, 2n], Array(MAX_METRICS_CORES + 1).fill([0, 1n, 2n])]]])),
		).toThrow(SchemaError);
	});

	it("agrees with crha on the shared interface-name cases", () => {
		for (const name of interfaceNameCases.valid) {
			expect(isValidMetricsInterfaceName(name), name).toBe(true);
		}
		for (const name of interfaceNameCases.invalid) {
			expect(isValidMetricsInterfaceName(name), JSON.stringify(name)).toBe(false);
		}
		// A lone surrogate is the JavaScript form of text no UTF-8 encoder can write, and Go rejects the
		// same name as invalid UTF-8.
		expect(isValidMetricsInterfaceName("\ud800")).toBe(false);
		// The limit is 15 bytes, not 15 characters: `网卡0` is 9 bytes, `éééééééé` is 16.
		expect(isValidMetricsInterfaceName("a".repeat(15))).toBe(true);
		expect(isValidMetricsInterfaceName("a".repeat(16))).toBe(false);
	});

	it("rejects an interface name whose wire bytes are not valid UTF-8", () => {
		// The metrics map's interface names are text, so the profile rejects a name carrying invalid
		// UTF-8 before the codec's per-entry drop applies; crha's decoder does the same.
		for (const hex of interfaceNameCases.invalid_utf8_hex) {
			const name = Uint8Array.from(Buffer.from(hex, "hex"));
			// {"interfaces": [[<name>, 1, 2, 3, 4]]}; the text header is 0x60 | length for these short names.
			const body = Uint8Array.from([
				0xa1,
				0x6a,
				...Buffer.from("interfaces"),
				0x81,
				0x85,
				0x60 | name.length,
				...name,
				1,
				2,
				3,
				4,
			]);
			expect(() => decodeCbor(body), hex).toThrow(CborError);
		}
	});

	it("drops a metrics entry whose name or core index is outside the protocol's form", () => {
		const wire = new Map<string, unknown>([
			[
				"disks",
				[
					["ok", ["bad name", "/", 1n, 2n]],
					["ok", ["data", "/data", 3n, 4n]],
					["ok", ["dot.name", "/dot", 5n, 6n]],
				],
			],
			[
				"interfaces",
				[
					["bad name", 1n, 2n, 3n, 4n],
					["a".repeat(16), 1n, 2n, 3n, 4n],
					[".", 1n, 2n, 3n, 4n],
					["..", 1n, 2n, 3n, 4n],
					["a/b", 1n, 2n, 3n, 4n],
					["a:b", 1n, 2n, 3n, 4n],
					["a\tb", 1n, 2n, 3n, 4n],
					["a\u0007b", 1n, 2n, 3n, 4n],
					["eth0", 5n, 6n, 7n, 8n],
					["veth@if3", 9n, 10n, 11n, 12n],
					["wlan0.100", 13n, 14n, 15n, 16n],
					["wg+0", 17n, 18n, 19n, 20n],
					["网卡0", 21n, 22n, 23n, 24n],
					["veth1a2b3c4", 25n, 26n, 27n, 28n],
					["br-1a2b", 29n, 30n, 31n, 32n],
				],
			],
			[
				"cpu",
				[
					[1n, 2n],
					[
						[0, 1n, 2n],
						[MAX_METRICS_CORES, 3n, 4n],
					],
				],
			],
		]);
		const decoded = metricsSnapshotCodec.decode(wire) as MetricsSnapshot;
		// The rest of the sample survives: only the offending entries are dropped.
		expect(decoded.disks).toEqual([{ kind: "ok", name: "data", path: "/data", totalBytes: 3n, usedBytes: 4n }]);
		expect(decoded.interfaces?.map((iface) => iface.name)).toEqual([
			"eth0",
			"veth@if3",
			"wlan0.100",
			"wg+0",
			"网卡0",
			"veth1a2b3c4",
			"br-1a2b",
		]);
		expect(decoded.cpu?.cores).toEqual([{ index: 0, busy: 1n, total: 2n }]);

		// A structurally malformed entry is still a decode error, not a silently dropped one.
		expect(() => metricsSnapshotCodec.decode(new Map([["disks", [["ok", ["data", "/data", 1n]]]]]))).toThrow(
			SchemaError,
		);
	});

	it("refuses to encode a metrics entry whose name or core index is outside the protocol's form", () => {
		const total = { busy: 1n, total: 2n };
		expect(() =>
			metricsSnapshotCodec.encode({
				disks: [{ kind: "ok", name: "bad name", path: "/", totalBytes: 1n, usedBytes: 2n }],
			}),
		).toThrow(SchemaError);
		expect(() =>
			metricsSnapshotCodec.encode({
				interfaces: [{ name: "a".repeat(16), rxBytes: 1n, txBytes: 2n, rxPackets: 3n, txPackets: 4n }],
			}),
		).toThrow(SchemaError);
		expect(() =>
			metricsSnapshotCodec.encode({
				interfaces: [{ name: "a\tb", rxBytes: 1n, txBytes: 2n, rxPackets: 3n, txPackets: 4n }],
			}),
		).toThrow(SchemaError);
		// A lone surrogate cannot be written as UTF-8, so it is refused like any other out-of-form name.
		expect(() =>
			metricsSnapshotCodec.encode({
				interfaces: [{ name: "\ud800", rxBytes: 1n, txBytes: 2n, rxPackets: 3n, txPackets: 4n }],
			}),
		).toThrow(SchemaError);
		expect(() =>
			metricsSnapshotCodec.encode({ cpu: { total, cores: [{ index: MAX_METRICS_CORES, busy: 1n, total: 2n }] } }),
		).toThrow(SchemaError);
	});

	it("tags a task result with the task kind and rejects anything else", () => {
		// The result is typed per kind: an unknown tag, the wrong arity or a mistyped field fails.
		expect(() => taskResultCodec.decode(["exec", []])).toThrow(SchemaError);
		expect(() => taskResultCodec.decode(["file.read", [1, 2, true]])).toThrow(SchemaError);
		expect(() => taskResultCodec.decode(["file.read", [1, 2, "yes", null, false]])).toThrow(SchemaError);
		expect(() => taskResultCodec.decode(["file.write", ["3", false]])).toThrow(SchemaError);
		expect(() => taskResultCodec.decode([5, []])).toThrow(SchemaError);
		const unknown = { kind: "exec" } as unknown as TaskResult;
		expect(() => taskResultCodec.encode(unknown)).toThrow("unknown tag");
		// task.exit requires the result element; a body without it does not decode.
		expect(() => taskExitCodec.decode(["t-1", ["code", 0], false, false, 0, 0, ""])).toThrow(SchemaError);
	});

	it("uses protocol 1.2, requires the base names and offers the optional ones", () => {
		expect(PROTOCOL_MAJOR).toBe(1);
		expect(PROTOCOL_MINOR).toBe(2);
		expect(REQUIRED_NAMES).toEqual([
			"hello",
			"ping",
			"task.start",
			"task.input",
			"task.cancel",
			"task.query",
			"task.output",
			"task.exit",
			"facts",
			"node.status",
			"task.output.ack",
			"task.exit.ack",
			"trust.summary",
		]);
		expect(OPTIONAL_NAMES).toEqual([
			"pty.open",
			"pty.resize",
			"pty.close",
			"pty.exited",
			"pty.list",
			"metrics.collect",
		]);
		expect(offeredNames()).toEqual([...REQUIRED_NAMES, ...OPTIONAL_NAMES]);
		expect(REQUIRED_NAMES).not.toContain("trust.query");
		expect(REQUIRED_NAMES).not.toContain("revocations.set");
		expect(REQUIRED_NAMES).not.toContain("pty.open");
		expect(PTY_NOISE_PROLOGUE_PREFIX).toBe("crh-pty/1");
		// A terminal's process ends by itself or, privileged, loses its privileged mode
		// (doc/design/pty.md "Lifecycle").
		expect([...PTY_EXIT_REASONS]).toEqual(["exited", "helper_lost"]);
	});

	it("registers every command and event", () => {
		expect(Object.keys(COMMANDS).sort()).toEqual([
			"hello",
			"metrics.collect",
			"ping",
			"pty.close",
			"pty.open",
			"pty.resize",
			"task.cancel",
			"task.input",
			"task.query",
			"task.start",
		]);
		expect(Object.keys(EVENTS).sort()).toEqual([
			"facts",
			"node.status",
			"pty.exited",
			"pty.list",
			"task.exit",
			"task.exit.ack",
			"task.output",
			"task.output.ack",
			"trust.summary",
		]);
	});

	it("derives request and response types from the registry", () => {
		const request: CommandRequest<"task.cancel"> = { taskId: "t-1" };
		const response: CommandResponse<"task.query"> = {
			taskId: "t-1",
			state: "unknown",
			outputEnd: 0,
		};
		expect(commandCodec.decode(commandCodec.encode({ argv: [] }))).toEqual({ argv: [] });
		expect(request.taskId).toBe("t-1");
		expect(response.state).toBe("unknown");
	});

	it("refuses a requested file mode above 0777", () => {
		const spec = (mode: number) =>
			({
				kind: "file.write",
				path: "/tmp/x",
				content: { size: 0, sha256: new Uint8Array(32) },
				overwrite: false,
				mode,
				owner: "",
				group: "",
				createParentDirs: false,
			}) as const;
		for (const mode of [0o777, 0o644, 0]) {
			expect(() => taskSpecCodec.encode(spec(mode))).not.toThrow();
		}
		for (const mode of [0o1000, 0o4755, 0o2755, 0o1755]) {
			expect(() => taskSpecCodec.encode(spec(mode))).toThrow(/file mode: above 0777/);
		}
		// A decoded spec is checked too, so a peer cannot send the bits either.
		const bytes = encodeCbor(taskSpecCodec.encode(spec(0o755)));
		const tampered = decodeCbor(bytes) as unknown[];
		const body = tampered[1] as unknown[];
		body[3] = 0o4755;
		expect(() => taskSpecCodec.decode(decodeCbor(encodeCbor(tampered)))).toThrow(/file mode: above 0777/);
	});

	it("rejects an untagged union value that matches more than one branch", () => {
		const ambiguous = { argv: ["echo", "hi"], shell: "echo hi" } as unknown as Command;
		expect(() => commandCodec.encode(ambiguous)).toThrow(SchemaError);
		expect(() => commandCodec.encode(ambiguous)).toThrow("ambiguous union value");
		expect(() => taskSpecCodec.encode({ kind: "exec", command: ambiguous, env: {}, cwd: "/tmp", stdin: null })).toThrow(
			"ambiguous union value",
		);
	});
});
