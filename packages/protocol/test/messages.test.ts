import { describe, expect, it } from "vitest";
import { decode as decodeCbor, encode as encodeCbor } from "../src/cbor.ts";
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
	pingCodec,
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
	REQUIRED_NAMES,
	SUPPORTED_NAMES,
} from "../src/registry.ts";
import { type Codec, SchemaError } from "../src/schema.ts";

const digest = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const facts: Facts = {
	hostname: "node-1",
	osId: "ubuntu",
	osVersionId: "24.04",
	osPrettyName: "Ubuntu 24.04 LTS",
	kernel: "6.8.0",
	arch: "x86_64",
	initSystem: "systemd",
	packageManagers: ["apt"],
	privilegeTools: ["sudo"],
	notesPath: "/etc/notes",
	clockOffsetMs: -5,
	shells: { sh: "/bin/sh", bash: "/usr/bin/bash" },
};

const status: TaskStatus = { taskId: "t-1", state: "running", stdoutEnd: 10, stderrEnd: 2 };
const ack: OutputAck = { taskId: "t-1", stdoutOffset: 10, stderrOffset: 2 };
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
};
const specEdit: TaskSpec = { kind: "file.edit", path: "/tmp/x", edits: [edit] };
const specStat: TaskSpec = { kind: "file.stat", path: "/tmp/x" };
const specList: TaskSpec = { kind: "file.list", path: "/tmp", limit: 0 };
const outputFull: OutputMode = { kind: "full", spillBytes: 1024, spillLines: 10 };
const outputText: OutputMode = { kind: "text" };
const outputStatus: OutputMode = { kind: "status" };
const taskStart: TaskStart = {
	taskId: "t-1",
	attempt: 1,
	spec: specExec,
	privileged: false,
	authorizations: [Uint8Array.of(0x00, 0xff)],
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
	stdoutEnd: 6,
	stderrEnd: 0,
	outputFile: "",
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
const taskOutput: TaskOutput = { taskId: "t-1", stream: "stdout", offset: 0, data: Uint8Array.of(4, 5) };
const nodeStatus: NodeStatus = { nodeId: "n-1", state: "active", message: "ok" };
const enrollment: Enrollment = { tokenSecret: "secret", hostname: "node-1", facts };
const handshakeInit: HandshakeInit = {
	protocolMajor: PROTOCOL_MAJOR,
	protocolMinor: PROTOCOL_MINOR,
	commands: [...SUPPORTED_NAMES],
	crhaVersion: "0.1.0",
	clientTimeMs: 1_700_000_000_000,
	enroll: enrollment,
};
const handshakeResponse: HandshakeResponse = {
	protocolMajor: PROTOCOL_MAJOR,
	protocolMinor: PROTOCOL_MINOR,
	commands: [...SUPPORTED_NAMES],
	connectionId: "conn-1",
	serverTimeMs: 1_700_000_000_000,
	nodeState: "active",
	nodeId: "n-1",
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
			"arch",
			"clock_offset_ms",
			"hostname",
			"init_system",
			"kernel",
			"notes_path",
			"os_id",
			"os_pretty_name",
			"os_version_id",
			"package_managers",
			"privilege_tools",
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
		// bash: null is accepted on decode too (doc/protocol.md Facts).
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
				["os_id", 1],
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

	it("tags a task result with the task kind and rejects anything else", () => {
		// The result is typed per kind: an unknown tag, the wrong arity or a mistyped field fails.
		expect(() => taskResultCodec.decode(["exec", []])).toThrow(SchemaError);
		expect(() => taskResultCodec.decode(["file.read", [1, 2, true]])).toThrow(SchemaError);
		expect(() => taskResultCodec.decode(["file.read", [1, 2, "yes", null, false]])).toThrow(SchemaError);
		expect(() => taskResultCodec.decode(["file.write", ["3", false]])).toThrow(SchemaError);
		expect(() => taskResultCodec.decode([5, []])).toThrow(SchemaError);
		const unknown = { kind: "exec" } as unknown as TaskResult;
		expect(() => taskResultCodec.encode(unknown)).toThrow("unknown tag");
		// task.exit requires the result element; a 1.0-length body no longer decodes.
		expect(() => taskExitCodec.decode(["t-1", ["code", 0], false, false, 0, 0, ""])).toThrow(SchemaError);
	});

	it("uses protocol 3.0 and keeps the M3.5 names required", () => {
		expect(PROTOCOL_MAJOR).toBe(3);
		expect(PROTOCOL_MINOR).toBe(0);
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
		]);
		expect(OPTIONAL_NAMES).toEqual(["local.request", "local.withdraw", "trust.summary", "local.decision"]);
		expect(SUPPORTED_NAMES).toEqual([...REQUIRED_NAMES, ...OPTIONAL_NAMES]);
		expect(SUPPORTED_NAMES).not.toContain("trust.query");
		expect(SUPPORTED_NAMES).not.toContain("revocations.set");
	});

	it("registers the 1.1 commands and events next to the 1.0 ones", () => {
		expect(Object.keys(COMMANDS).sort()).toEqual([
			"hello",
			"local.request",
			"local.withdraw",
			"ping",
			"task.cancel",
			"task.input",
			"task.query",
			"task.start",
		]);
		expect(Object.keys(EVENTS).sort()).toEqual([
			"facts",
			"local.decision",
			"node.status",
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
			stdoutEnd: 0,
			stderrEnd: 0,
		};
		expect(commandCodec.decode(commandCodec.encode({ argv: [] }))).toEqual({ argv: [] });
		expect(request.taskId).toBe("t-1");
		expect(response.state).toBe("unknown");
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
