import { describe, expect, it } from "vitest";
import { decode as decodeCbor, encode as encodeCbor } from "../src/cbor.ts";
import {
	COMMANDS,
	type Command,
	type CommandRequest,
	type CommandResponse,
	commandCodec,
	type Edit,
	type Enrollment,
	EVENTS,
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
	SUPPORTED_NAMES,
	type TaskExit,
	type TaskInput,
	type TaskOutput,
	type TaskSpec,
	type TaskStart,
	type TaskStatus,
	taskCancelCodec,
	taskExitAckCodec,
	taskExitCodec,
	taskInputCodec,
	taskOutputCodec,
	taskQueryCodec,
	taskSpecCodec,
	taskStartCodec,
	taskStatusCodec,
	type Welcome,
	welcomeCodec,
} from "../src/messages.ts";
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
	groups: ["sudo"],
	clockOffsetMs: -5,
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
const specRead: TaskSpec = { kind: "file.read", path: "/etc/hosts", offset: 0, limit: 0 };
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
};
const hello: Hello = { tasks: [status], taskKinds: ["exec"], privilegedMode: "disabled" };
const welcome: Welcome = { acks: [ack] };
const taskInput: TaskInput = { taskId: "t-1", offset: 0, data: Uint8Array.of(1, 2, 3) };
const taskOutput: TaskOutput = { taskId: "t-1", stream: "stdout", offset: 0, data: Uint8Array.of(4, 5) };
const nodeStatus: NodeStatus = { nodeId: "n-1", state: "active", message: "ok" };
const enrollment: Enrollment = { tokenSecret: "secret", hostname: "node-1", facts };
const handshakeInit: HandshakeInit = {
	protocolMajor: 1,
	protocolMinor: 0,
	commands: [...SUPPORTED_NAMES],
	crhaVersion: "0.1.0",
	clientTimeMs: 1_700_000_000_000,
	enroll: enrollment,
};
const handshakeResponse: HandshakeResponse = {
	protocolMajor: 1,
	protocolMinor: 0,
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
	asCase("TaskExit", taskExitCodec, taskExit),
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

	it("uses the protocol version and complete 1.0 name set", () => {
		expect(PROTOCOL_MAJOR).toBe(1);
		expect(PROTOCOL_MINOR).toBe(0);
		expect(SUPPORTED_NAMES).toEqual([
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
		expect(SUPPORTED_NAMES).not.toContain("trust.query");
		expect(SUPPORTED_NAMES).not.toContain("revocations.set");
		expect(SUPPORTED_NAMES).not.toContain("trust.summary");
	});

	it("registers exactly the 1.0 commands and events", () => {
		expect(Object.keys(COMMANDS).sort()).toEqual([
			"hello",
			"ping",
			"task.cancel",
			"task.input",
			"task.query",
			"task.start",
		]);
		expect(Object.keys(EVENTS).sort()).toEqual([
			"facts",
			"node.status",
			"task.exit",
			"task.exit.ack",
			"task.output",
			"task.output.ack",
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
