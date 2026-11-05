/**
 * Generates test/interop/crh_frames.json. The vitest suite asserts that the
 * committed file is byte-for-byte the result of this generator.
 */
import { encode as encodeCbor } from "../src/cbor.ts";
import { encodeFrame, type Frame } from "../src/frame.ts";
import {
	type Facts,
	type HandshakeInit,
	type HandshakeResponse,
	handshakeInitCodec,
	handshakeResponseCodec,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	type TaskResult,
	type TaskStart,
	type TaskStatus,
} from "../src/messages.ts";
import type { TrustSummary } from "../src/privileged.ts";
import { SUPPORTED_NAMES } from "../src/registry.ts";

export interface FixtureCase {
	id: string;
	description: string;
	hex: string;
}

export interface CrhFramesFixture {
	positive: FixtureCase[];
	negative: FixtureCase[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const bytesOf = (hexText: string): Uint8Array => Uint8Array.from(Buffer.from(hexText, "hex"));

const FACTS: Facts = {
	hostname: "node-1",
	osId: "ubuntu",
	osVersionId: "24.04",
	osPrettyName: "Ubuntu 24.04 LTS",
	kernel: "6.8.0-31-generic",
	arch: "x86_64",
	initSystem: "systemd",
	packageManagers: ["apt", "snap"],
	privilegeTools: ["sudo"],
	notesPath: "/etc/crh/notes",
	clockOffsetMs: -1234,
	shells: { sh: "/bin/sh", bash: "/usr/bin/bash" },
};

const FACTS_TEXT =
	'facts={hostname="node-1", os_id="ubuntu", os_version_id="24.04", ' +
	'os_pretty_name="Ubuntu 24.04 LTS", kernel="6.8.0-31-generic", arch="x86_64", init_system="systemd", ' +
	'package_managers=["apt","snap"], privilege_tools=["sudo"], notes_path="/etc/crh/notes", ' +
	'clock_offset_ms=-1234, shells={sh="/bin/sh", bash="/usr/bin/bash"}}';

/**
 * The fixture Facts as the wire map. A Map, unlike the typed object, can carry keys the codec does
 * not know, which Facts must ignore (doc/protocol.md Facts); the encoder sorts the keys.
 */
function factsMap(overrides: readonly (readonly [string, unknown])[] = []): Map<string, unknown> {
	return new Map<string, unknown>([
		["hostname", "node-1"],
		["os_id", "ubuntu"],
		["os_version_id", "24.04"],
		["os_pretty_name", "Ubuntu 24.04 LTS"],
		["kernel", "6.8.0-31-generic"],
		["arch", "x86_64"],
		["init_system", "systemd"],
		["package_managers", ["apt", "snap"]],
		["privilege_tools", ["sudo"]],
		["notes_path", "/etc/crh/notes"],
		["clock_offset_ms", -1234],
		[
			"shells",
			new Map<string, unknown>([
				["sh", "/bin/sh"],
				["bash", "/usr/bin/bash"],
			]),
		],
		...overrides,
	]);
}

/** A facts event frame around a raw facts map. */
function factsEvent(body: ReadonlyMap<unknown, unknown>): Uint8Array {
	return encodeCbor([2, "facts", body]);
}

const COMMANDS_TEXT = `commands=[${SUPPORTED_NAMES.join(",")}]`;
const AUTHORIZATION = bytesOf("00ff");
const SHA_111 = new Uint8Array(32).fill(0x11);
const SHA_222 = new Uint8Array(32).fill(0x22);

const TRUST_SUMMARY: TrustSummary = {
	nodeId: "node-1",
	aliases: ["0192f000-0000-7000-8000-0000000000a1"],
	clockSkewMs: 60000,
	identities: {
		unprivileged: { uid: 998, gid: 998, user: "crha" },
		privileged: { uid: 0, gid: 0, user: "root" },
	},
	trust: [
		{
			name: "crhs",
			source: "local",
			role: "crhs",
			key: {
				kind: "sshsig",
				publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEjcrhssigningkeyexample crhs-signing",
				fingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
			},
			kinds: ["execute", "cosign"],
			requireExact: true,
			requireTask: true,
			requireUv: false,
			maxTtlMs: 300000,
			allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
			deny: [],
			envAllow: [],
		},
		{
			name: "alice-passkey",
			source: "local",
			role: "user",
			key: {
				kind: "webauthn",
				credentialId: SHA_111,
				coseKey: bytesOf("a5010203262001215820"),
				rpId: "crh.example.com",
				origins: ["https://crh.example.com"],
			},
			kinds: ["execute"],
			requireExact: false,
			requireTask: true,
			requireUv: true,
			maxTtlMs: null,
			allow: [],
			deny: [],
			envAllow: ["DEBIAN_FRONTEND"],
		},
		{
			name: "local-admins",
			source: "local",
			role: "local",
			key: { kind: "local", uids: [0, 1000] },
			kinds: ["execute"],
			requireExact: false,
			requireTask: false,
			requireUv: false,
			maxTtlMs: null,
			allow: [],
			deny: [],
			envAllow: [],
		},
	],
};

const EXEC_ARGV: TaskStart = {
	taskId: "t-exec-argv",
	attempt: 1,
	spec: {
		kind: "exec",
		command: { argv: ["/bin/echo", "hi"] },
		env: { B: "2", A: "1" },
		cwd: "/tmp/数据",
		stdin: null,
	},
	privileged: false,
	authorizations: [AUTHORIZATION],
	timeoutMs: 30000,
	killGraceMs: 5000,
	output: { kind: "full", spillBytes: 1048576, spillLines: 1000 },
};

const EXEC_SHELL: TaskStart = {
	taskId: "t-exec-shell",
	attempt: 2,
	spec: {
		kind: "exec",
		command: { shell: "echo 你好 | wc -c" },
		env: {},
		cwd: "/tmp",
		stdin: { size: 3, sha256: SHA_111 },
	},
	privileged: false,
	authorizations: [],
	timeoutMs: 5000,
	killGraceMs: 1000,
	output: { kind: "text" },
};

const TASK_STATUS_RUNNING: TaskStatus = {
	taskId: "t-run",
	state: "running",
	stdoutEnd: 10,
	stderrEnd: 2,
};

function taskStartWithSpec(taskId: string, spec: TaskStart["spec"], output: TaskStart["output"]): TaskStart {
	return {
		taskId,
		attempt: 1,
		spec,
		privileged: false,
		authorizations: [],
		timeoutMs: 0,
		killGraceMs: 0,
		output,
	};
}

const READ_RESULT: TaskResult = { kind: "file.read", from: 1, to: 2, eof: true, total: 3, tooLong: false };
const STAT_RESULT: TaskResult = {
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
const LIST_RESULT: TaskResult = {
	kind: "file.list",
	entries: [{ name: "f.txt", type: "file", size: 7, mode: "0644", mtime: "2026-01-01T00:00:00Z" }],
	truncated: false,
};
const WRITE_RESULT: TaskResult = { kind: "file.write", bytes: 3, created: true };
const EDIT_RESULT: TaskResult = { kind: "file.edit", replacements: 2 };

/**
 * The task.exit frame of a task that ran cleanly, kept `stdoutEnd` bytes, counted `outputLines`
 * lines of merged output and reported `result`.
 */
function exitFrame(taskId: string, result: TaskResult, stdoutEnd = 0, outputLines = 0): Frame {
	return {
		kind: "event",
		name: "task.exit",
		body: {
			taskId,
			outcome: { kind: "code", value: 0 },
			timedOut: false,
			cancelled: false,
			stdoutEnd,
			stderrEnd: 0,
			outputFile: "",
			outputLines,
			result,
		},
	};
}

export function buildFixture(): CrhFramesFixture {
	const positive: FixtureCase[] = [];
	const negative: FixtureCase[] = [];
	const addPositive = (id: string, description: string, bytes: Uint8Array): void => {
		positive.push({ id, description, hex: hex(bytes) });
	};
	const addNegative = (id: string, description: string, bytes: Uint8Array): void => {
		negative.push({ id, description, hex: hex(bytes) });
	};
	const addFrame = (id: string, description: string, frame: Frame): void => {
		addPositive(id, description, encodeFrame(frame));
	};

	// Handshake payloads (not frames).
	const initNoEnroll: HandshakeInit = {
		protocolMajor: PROTOCOL_MAJOR,
		protocolMinor: PROTOCOL_MINOR,
		commands: [...SUPPORTED_NAMES],
		crhaVersion: "0.1.0-test",
		clientTimeMs: 1700000000000,
		enroll: null,
	};
	addPositive(
		"handshake.init.no-enroll",
		`HandshakeInit protocol_major=${PROTOCOL_MAJOR} protocol_minor=${PROTOCOL_MINOR} ${COMMANDS_TEXT} crha_version="0.1.0-test" client_time_ms=1700000000000 enroll=null`,
		encodeCbor(handshakeInitCodec.encode(initNoEnroll)),
	);
	const initEnroll: HandshakeInit = {
		protocolMajor: PROTOCOL_MAJOR,
		protocolMinor: PROTOCOL_MINOR,
		commands: ["hello", "ping"],
		crhaVersion: "0.1.0-test",
		clientTimeMs: 1700000000000,
		enroll: { tokenSecret: "enroll-secret", hostname: "node-1", facts: FACTS },
	};
	addPositive(
		"handshake.init.enroll",
		`HandshakeInit protocol_major=${PROTOCOL_MAJOR} protocol_minor=${PROTOCOL_MINOR} commands=[hello,ping] crha_version="0.1.0-test" client_time_ms=1700000000000 enroll=[token_secret="enroll-secret", hostname="node-1", ${FACTS_TEXT}]`,
		encodeCbor(handshakeInitCodec.encode(initEnroll)),
	);
	const responseActive: HandshakeResponse = {
		protocolMajor: PROTOCOL_MAJOR,
		protocolMinor: PROTOCOL_MINOR,
		commands: [...SUPPORTED_NAMES],
		connectionId: "conn-1",
		serverTimeMs: 1700000001234,
		nodeState: "active",
		nodeId: "node-1",
	};
	addPositive(
		"handshake.response.active",
		`HandshakeResponse protocol_major=${PROTOCOL_MAJOR} protocol_minor=${PROTOCOL_MINOR} ${COMMANDS_TEXT} connection_id="conn-1" server_time_ms=1700000001234 node_state="active" node_id="node-1"`,
		encodeCbor(handshakeResponseCodec.encode(responseActive)),
	);
	const responsePending: HandshakeResponse = { ...responseActive, nodeState: "pending" };
	addPositive(
		"handshake.response.pending",
		`HandshakeResponse protocol_major=${PROTOCOL_MAJOR} protocol_minor=${PROTOCOL_MINOR} ${COMMANDS_TEXT} connection_id="conn-1" server_time_ms=1700000001234 node_state="pending" node_id="node-1"`,
		encodeCbor(handshakeResponseCodec.encode(responsePending)),
	);

	// Commands: one request and one success response per command.
	addFrame(
		"request.hello",
		'request id=1 cmd=hello body=[tasks=[[task_id="t-run", state="running", stdout_end=10, stderr_end=2]], task_kinds=["exec","file.read"], privileged_mode="disabled"]',
		{
			kind: "request",
			id: 1,
			cmd: "hello",
			body: { tasks: [TASK_STATUS_RUNNING], taskKinds: ["exec", "file.read"], privilegedMode: "disabled" },
		},
	);
	addFrame(
		"response.hello",
		'response id=1 cmd=hello ok=true body=[acks=[[task_id="t-run", stdout_offset=10, stderr_offset=2]]]',
		{
			kind: "response",
			id: 1,
			cmd: "hello",
			ok: true,
			body: { acks: [{ taskId: "t-run", stdoutOffset: 10, stderrOffset: 2 }] },
		},
	);
	addFrame("request.ping", "request id=2 cmd=ping body=[seq=42]", {
		kind: "request",
		id: 2,
		cmd: "ping",
		body: { seq: 42 },
	});
	addFrame("response.ping", "response id=2 cmd=ping ok=true body=[seq=42]", {
		kind: "response",
		id: 2,
		cmd: "ping",
		ok: true,
		body: { seq: 42 },
	});

	addFrame(
		"request.task.start.exec.argv",
		'request id=3 cmd=task.start body=[task_id="t-exec-argv", attempt=1, spec=["exec", [command=["argv", ["/bin/echo", "hi"]], env={A:"1",B:"2"}, cwd="/tmp/数据", stdin=null]], privileged=false, authorizations=[h\'00ff\'], timeout_ms=30000, kill_grace_ms=5000, output=["full", [spill_bytes=1048576, spill_lines=1000]]]',
		{ kind: "request", id: 3, cmd: "task.start", body: EXEC_ARGV },
	);
	addFrame(
		"request.task.start.exec.shell",
		'request id=4 cmd=task.start body=[task_id="t-exec-shell", attempt=2, spec=["exec", [command=["shell", "echo 你好 | wc -c"], env={}, cwd="/tmp", stdin=[size=3, sha256=32 bytes of 0x11]]], privileged=false, authorizations=[], timeout_ms=5000, kill_grace_ms=1000, output=["text", []]]',
		{ kind: "request", id: 4, cmd: "task.start", body: EXEC_SHELL },
	);
	addFrame(
		"request.task.start.file.read",
		'request id=5 cmd=task.start body=[task_id="t-read", attempt=1, spec=["file.read", [path="/etc/hosts", startLine=1, lineCount=100]], privileged=false, authorizations=[], timeout_ms=0, kill_grace_ms=0, output=["status", []]]',
		{
			kind: "request",
			id: 5,
			cmd: "task.start",
			body: taskStartWithSpec(
				"t-read",
				{ kind: "file.read", path: "/etc/hosts", startLine: 1, lineCount: 100 },
				{
					kind: "status",
				},
			),
		},
	);
	addFrame(
		"request.task.start.file.write",
		'request id=6 cmd=task.start body=[task_id="t-write", attempt=1, spec=["file.write", [path="/tmp/x", content=[size=3, sha256=32 bytes of 0x22], overwrite=false, mode=0, owner="", group=""]], privileged=false, authorizations=[], timeout_ms=0, kill_grace_ms=0, output=["status", []]]',
		{
			kind: "request",
			id: 6,
			cmd: "task.start",
			body: taskStartWithSpec(
				"t-write",
				{
					kind: "file.write",
					path: "/tmp/x",
					content: { size: 3, sha256: SHA_222 },
					overwrite: false,
					mode: 0,
					owner: "",
					group: "",
				},
				{ kind: "status" },
			),
		},
	);
	addFrame(
		"request.task.start.file.edit",
		'request id=7 cmd=task.start body=[task_id="t-edit", attempt=1, spec=["file.edit", [path="/tmp/x", edits=[[old_text="a", new_text="b"], [old_text="你好", new_text="世界"]]]], privileged=false, authorizations=[], timeout_ms=0, kill_grace_ms=0, output=["status", []]]',
		{
			kind: "request",
			id: 7,
			cmd: "task.start",
			body: taskStartWithSpec(
				"t-edit",
				{
					kind: "file.edit",
					path: "/tmp/x",
					edits: [
						{ oldText: "a", newText: "b" },
						{ oldText: "你好", newText: "世界" },
					],
				},
				{ kind: "status" },
			),
		},
	);
	addFrame(
		"request.task.start.file.stat",
		'request id=8 cmd=task.start body=[task_id="t-stat", attempt=1, spec=["file.stat", [path="/tmp/x"]], privileged=false, authorizations=[], timeout_ms=0, kill_grace_ms=0, output=["status", []]]',
		{
			kind: "request",
			id: 8,
			cmd: "task.start",
			body: taskStartWithSpec("t-stat", { kind: "file.stat", path: "/tmp/x" }, { kind: "status" }),
		},
	);
	addFrame(
		"request.task.start.file.list",
		'request id=9 cmd=task.start body=[task_id="t-list", attempt=1, spec=["file.list", [path="/tmp", limit=0]], privileged=false, authorizations=[], timeout_ms=0, kill_grace_ms=0, output=["status", []]]',
		{
			kind: "request",
			id: 9,
			cmd: "task.start",
			body: taskStartWithSpec("t-list", { kind: "file.list", path: "/tmp", limit: 0 }, { kind: "status" }),
		},
	);
	addFrame("response.task.start", "response id=3 cmd=task.start ok=true body=[]", {
		kind: "response",
		id: 3,
		cmd: "task.start",
		ok: true,
		body: {},
	});
	addFrame(
		"response.task.start.error",
		'response id=3 cmd=task.start ok=false body=[code="unsupported_kind", message="kind not supported"]',
		{
			kind: "response",
			id: 3,
			cmd: "task.start",
			ok: false,
			error: { code: "unsupported_kind", message: "kind not supported" },
		},
	);

	addFrame(
		"request.task.input",
		"request id=10 cmd=task.input body=[task_id=\"t-exec-shell\", offset=0, data=h'000102ff']",
		{
			kind: "request",
			id: 10,
			cmd: "task.input",
			body: { taskId: "t-exec-shell", offset: 0, data: bytesOf("000102ff") },
		},
	);
	addFrame("response.task.input", "response id=10 cmd=task.input ok=true body=[]", {
		kind: "response",
		id: 10,
		cmd: "task.input",
		ok: true,
		body: {},
	});
	addFrame("request.task.cancel", 'request id=11 cmd=task.cancel body=[task_id="t-exec-argv"]', {
		kind: "request",
		id: 11,
		cmd: "task.cancel",
		body: { taskId: "t-exec-argv" },
	});
	addFrame("response.task.cancel", "response id=11 cmd=task.cancel ok=true body=[]", {
		kind: "response",
		id: 11,
		cmd: "task.cancel",
		ok: true,
		body: {},
	});
	addFrame("request.task.query", 'request id=12 cmd=task.query body=[task_id="t-exec-argv"]', {
		kind: "request",
		id: 12,
		cmd: "task.query",
		body: { taskId: "t-exec-argv" },
	});
	addFrame(
		"response.task.query",
		'response id=12 cmd=task.query ok=true body=[task_id="t-exec-argv", state="exited", stdout_end=6, stderr_end=0]',
		{
			kind: "response",
			id: 12,
			cmd: "task.query",
			ok: true,
			body: { taskId: "t-exec-argv", state: "exited", stdoutEnd: 6, stderrEnd: 0 },
		},
	);
	addFrame("response.error", 'response id=11 cmd=task.cancel ok=false body=[code="internal_error", message="boom"]', {
		kind: "response",
		id: 11,
		cmd: "task.cancel",
		ok: false,
		error: { code: "internal_error", message: "boom" },
	});

	// M4 (optional) commands and events.
	addFrame(
		"request.local.request",
		'request id=14 cmd=local.request body=[task_id="t-read", attempt=1, spec=["file.read", [path="/etc/hosts", startLine=1, lineCount=100]], note="restart nginx"]',
		{
			kind: "request",
			id: 14,
			cmd: "local.request",
			body: {
				taskId: "t-read",
				attempt: 1,
				spec: { kind: "file.read", path: "/etc/hosts", startLine: 1, lineCount: 100 },
				note: "restart nginx",
			},
		},
	);
	addFrame("response.local.request", 'response id=14 cmd=local.request ok=true body=["pending", []]', {
		kind: "response",
		id: 14,
		cmd: "local.request",
		ok: true,
		body: { kind: "pending" },
	});
	addFrame("request.local.withdraw", 'request id=15 cmd=local.withdraw body=[task_id="t-read", attempt=1]', {
		kind: "request",
		id: 15,
		cmd: "local.withdraw",
		body: { taskId: "t-read", attempt: 1 },
	});
	addFrame("response.local.withdraw", "response id=15 cmd=local.withdraw ok=true body=[]", {
		kind: "response",
		id: 15,
		cmd: "local.withdraw",
		ok: true,
		body: {},
	});

	// Events.
	addFrame(
		"event.task.output",
		'event task.output body=[task_id="t-exec-argv", stream="stdout", offset=0, data=h\'68656c6c6f0a\']',
		{
			kind: "event",
			name: "task.output",
			body: { taskId: "t-exec-argv", stream: "stdout", offset: 0, data: Buffer.from("hello\n") },
		},
	);
	addFrame(
		"event.task.exit.code",
		'event task.exit body=[task_id="t-exec-argv", outcome=["code", 0], timed_out=false, cancelled=false, stdout_end=6, stderr_end=0, output_file="", output_lines=1, result=null]',
		{
			kind: "event",
			name: "task.exit",
			body: {
				taskId: "t-exec-argv",
				outcome: { kind: "code", value: 0 },
				timedOut: false,
				cancelled: false,
				stdoutEnd: 6,
				stderrEnd: 0,
				outputFile: "",
				outputLines: 1,
				result: null,
			},
		},
	);
	addFrame(
		"event.task.exit.signal",
		'event task.exit body=[task_id="t-exec-shell", outcome=["signal", "TERM"], timed_out=false, cancelled=true, stdout_end=3, stderr_end=0, output_file="", output_lines=0, result=null]',
		{
			kind: "event",
			name: "task.exit",
			body: {
				taskId: "t-exec-shell",
				outcome: { kind: "signal", value: "TERM" },
				timedOut: false,
				cancelled: true,
				stdoutEnd: 3,
				stderrEnd: 0,
				outputFile: "",
				outputLines: 0,
				result: null,
			},
		},
	);
	addFrame(
		"event.task.exit.error",
		'event task.exit body=[task_id="t-edit", outcome=["error", [code="internal_error", message="failed"]], timed_out=true, cancelled=false, stdout_end=0, stderr_end=0, output_file="/tmp/out", output_lines=0, result=null]',
		{
			kind: "event",
			name: "task.exit",
			body: {
				taskId: "t-edit",
				outcome: { kind: "error", code: "internal_error", message: "failed" },
				timedOut: true,
				cancelled: false,
				stdoutEnd: 0,
				stderrEnd: 0,
				outputFile: "/tmp/out",
				outputLines: 0,
				result: null,
			},
		},
	);
	addFrame(
		"event.task.exit.error.bom",
		'event task.exit body=[task_id="t-bom", outcome=["error", [code="io_error", message="\\uFEFFbom"]], timed_out=false, cancelled=false, stdout_end=0, stderr_end=0, output_file="", output_lines=0, result=null]',
		{
			kind: "event",
			name: "task.exit",
			body: {
				taskId: "t-bom",
				outcome: { kind: "error", code: "io_error", message: "\uFEFFbom" },
				timedOut: false,
				cancelled: false,
				stdoutEnd: 0,
				stderrEnd: 0,
				outputFile: "",
				outputLines: 0,
				result: null,
			},
		},
	);
	// A task's structured result travels in task.exit, never in the output streams (doc/protocol.md
	// TaskResult). One frame per kind; the tag is the task kind.
	addFrame(
		"event.task.exit.result.file.read",
		'event task.exit body=[task_id="t-read", outcome=["code", 0], timed_out=false, cancelled=false, stdout_end=8, stderr_end=0, output_file="", output_lines=0, result=["file.read", [from=1, to=2, eof=true, total=3, too_long=false]]]',
		exitFrame("t-read", READ_RESULT, 8),
	);
	addFrame(
		"event.task.exit.result.file.stat",
		'event task.exit body=[task_id="t-stat", outcome=["code", 0], timed_out=false, cancelled=false, stdout_end=0, stderr_end=0, output_file="", output_lines=0, result=["file.stat", [path="/tmp/x", type="file", size=7, mode="0644", uid=1000, gid=1000, owner="alice", group="alice", mtime="2026-01-01T00:00:00Z", link_target=null]]]',
		exitFrame("t-stat", STAT_RESULT),
	);
	addFrame(
		"event.task.exit.result.file.list",
		'event task.exit body=[task_id="t-list", outcome=["code", 0], timed_out=false, cancelled=false, stdout_end=0, stderr_end=0, output_file="", output_lines=0, result=["file.list", [entries=[[name="f.txt", type="file", size=7, mode="0644", mtime="2026-01-01T00:00:00Z"]], truncated=false]]]',
		exitFrame("t-list", LIST_RESULT),
	);
	addFrame(
		"event.task.exit.result.file.write",
		'event task.exit body=[task_id="t-write", outcome=["code", 0], timed_out=false, cancelled=false, stdout_end=0, stderr_end=0, output_file="", output_lines=0, result=["file.write", [bytes=3, created=true]]]',
		exitFrame("t-write", WRITE_RESULT),
	);
	addFrame(
		"event.task.exit.result.file.edit",
		'event task.exit body=[task_id="t-edit-result", outcome=["code", 0], timed_out=false, cancelled=false, stdout_end=0, stderr_end=0, output_file="", output_lines=0, result=["file.edit", [replacements=2]]]',
		exitFrame("t-edit-result", EDIT_RESULT),
	);
	addFrame("event.facts", `event facts body=${FACTS_TEXT}`, { kind: "event", name: "facts", body: FACTS });
	// Facts is the protocol's one map (doc/protocol.md Facts): unknown keys are ignored, absent
	// optionals are accepted, and shells is itself a map with an optional bash.
	addPositive(
		"event.facts.unknown_key",
		"event facts map with an unknown fact key (ignored)",
		factsEvent(factsMap([["future_fact", "ignored"]])),
	);
	addPositive(
		"event.facts.minimal",
		"event facts map with only the required key hostname, every optional absent",
		factsEvent(new Map<string, unknown>([["hostname", "node-1"]])),
	);
	addPositive(
		"event.facts.shells_unknown_key",
		"event facts map whose shells map has an unknown inner key zsh (ignored)",
		factsEvent(
			factsMap([
				[
					"shells",
					new Map<string, unknown>([
						["sh", "/bin/sh"],
						["bash", "/usr/bin/bash"],
						["zsh", "/usr/bin/zsh"],
					]),
				],
			]),
		),
	);
	addPositive(
		"event.facts.shells_without_bash",
		"event facts map whose shells map has no bash key at all",
		factsEvent(factsMap([["shells", new Map<string, unknown>([["sh", "/bin/sh"]])]])),
	);
	addFrame("event.node.status", 'event node.status body=[node_id="node-1", state="active", message="approved"]', {
		kind: "event",
		name: "node.status",
		body: { nodeId: "node-1", state: "active", message: "approved" },
	});
	addFrame("event.node.status.pending", 'event node.status body=[node_id="node-1", state="pending", message=""]', {
		kind: "event",
		name: "node.status",
		body: { nodeId: "node-1", state: "pending", message: "" },
	});
	addFrame(
		"event.node.status.rejected",
		'event node.status body=[node_id="node-1", state="rejected", message="denied"]',
		{
			kind: "event",
			name: "node.status",
			body: { nodeId: "node-1", state: "rejected", message: "denied" },
		},
	);
	addFrame("event.node.status.disabled", 'event node.status body=[node_id="node-1", state="disabled", message=""]', {
		kind: "event",
		name: "node.status",
		body: { nodeId: "node-1", state: "disabled", message: "" },
	});
	addFrame(
		"event.task.output.ack",
		'event task.output.ack body=[task_id="t-exec-argv", stdout_offset=6, stderr_offset=0]',
		{
			kind: "event",
			name: "task.output.ack",
			body: { taskId: "t-exec-argv", stdoutOffset: 6, stderrOffset: 0 },
		},
	);
	addFrame("event.task.exit.ack", 'event task.exit.ack body=[task_id="t-exec-argv"]', {
		kind: "event",
		name: "task.exit.ack",
		body: { taskId: "t-exec-argv" },
	});
	addFrame(
		"event.trust.summary",
		'event trust.summary body=["ok", [node_id="node-1", aliases=["0192f000-0000-7000-8000-0000000000a1"], clock_skew_ms=60000, identities=[[uid=998, gid=998, user="crha"], [uid=0, gid=0, user="root"]], trust=[[name="crhs", source="local", role="crhs", key=["sshsig", [public_key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEjcrhssigningkeyexample crhs-signing", fingerprint="SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU"]], kinds=["execute","cosign"], require_exact=true, require_task=true, require_uv=false, max_ttl_ms=300000, allow=[["exec", "prefix", "systemctl restart "]], deny=[], env_allow=[]], [name="alice-passkey", source="local", role="user", key=["webauthn", [credential_id=32 bytes of 0x11, cose_key=h\'a5010203262001215820\', rp_id="crh.example.com", origins=["https://crh.example.com"]]], kinds=["execute"], require_exact=false, require_task=true, require_uv=true, max_ttl_ms=null, allow=[], deny=[], env_allow=["DEBIAN_FRONTEND"]], [name="local-admins", source="local", role="local", key=["local", [uids=[0, 1000]]], kinds=["execute"], require_exact=false, require_task=false, require_uv=false, max_ttl_ms=null, allow=[], deny=[], env_allow=[]]]]]',
		{ kind: "event", name: "trust.summary", body: { kind: "ok", summary: TRUST_SUMMARY } },
	);
	addFrame(
		"event.local.decision",
		'event local.decision body=[task_id="t-read", attempt=1, state=["denied", [message="not now"]]]',
		{
			kind: "event",
			name: "local.decision",
			body: { taskId: "t-read", attempt: 1, state: { kind: "denied", message: "not now" } },
		},
	);

	// Negative cases.
	addNegative(
		"negative.tuple_length",
		"request has five elements instead of four",
		encodeCbor([0, 1, "ping", [1], 99]),
	);
	addNegative(
		"negative.body_tuple_length",
		"ping request body has two elements instead of one",
		encodeCbor([0, 30, "ping", [1, 2]]),
	);
	addNegative(
		"negative.unknown_union_tag",
		'task.start TaskSpec union tag is "bogus" instead of one of the six known tags',
		encodeCbor([0, 20, "task.start", ["t-bad", 1, ["bogus", []], false, [], 0, 0, ["status", []]]]),
	);
	addNegative(
		"negative.unknown_enum_value",
		'task.query response task state is "bogus" instead of running|exited|unknown',
		encodeCbor([1, 21, "task.query", true, ["t-bad", "bogus", 0, 0]]),
	);
	addNegative(
		"negative.nonminimal_int",
		"request id 1 is encoded with the two-byte integer 0x1801 instead of 0x01",
		bytesOf("840018016470696e678101"),
	);
	addNegative(
		"negative.float_for_uint",
		"ping sequence number is the float 1.5 (0xf93e00) where uint is required",
		bytesOf("8400016470696e6781f93e00"),
	);
	addNegative(
		"negative.uint_over_2_53",
		"ping sequence number is 9007199254740993 (2^53 + 1), beyond the protocol's uint range",
		bytesOf("8400016470696e67811b0020000000000001"),
	);
	addNegative(
		"negative.sha256_31_bytes",
		"exec stdin InputRef sha256 is 31 bytes instead of 32",
		encodeCbor([
			0,
			22,
			"task.start",
			["t-bad", 1, ["exec", [["argv", []], {}, "", [0, new Uint8Array(31)]]], false, [], 0, 0, ["status", []]],
		]),
	);
	const trailing = Buffer.from(encodeFrame({ kind: "request", id: 23, cmd: "task.cancel", body: { taskId: "t" } }));
	addNegative(
		"negative.trailing_bytes",
		"valid task.cancel request followed by one extra 0x00 byte",
		Buffer.concat([trailing, Buffer.from([0x00])]),
	);
	addNegative("negative.tag_present", "request id is wrapped in CBOR tag 1 (0xc1)", bytesOf("8400c1016470696e678101"));
	addNegative(
		"negative.indefinite_array",
		"request frame uses an indefinite-length array (0x9f ... 0xff)",
		bytesOf("9f00016470696e678101ff"),
	);
	{
		const source = Buffer.from(encodeFrame({ kind: "request", id: 24, cmd: "task.start", body: EXEC_ARGV }));
		const needle = Buffer.from("a26141613161426132", "hex");
		const at = source.indexOf(needle);
		if (at < 0) throw new Error("duplicate-key fixture anchor not found");
		const duplicate = Buffer.from("a26141613161416132", "hex");
		addNegative(
			"negative.duplicate_env_key",
			'exec env map has two entries with key "A"',
			Buffer.concat([source.subarray(0, at), duplicate, source.subarray(at + needle.length)]),
		);
	}
	addNegative("negative.unknown_frame_type", "frame type is 3", encodeCbor([3, 1]));
	addNegative(
		"negative.error_body_shape",
		"ok=false response body is [1] instead of [code, message]",
		encodeCbor([1, 25, "task.cancel", false, [1]]),
	);
	addNegative(
		"negative.float_integer_value",
		"ping sequence number is the float 1.0 (0xf93c00) where uint is required",
		bytesOf("8400016470696e6781f93c00"),
	);
	addNegative(
		"negative.invalid_utf8_text",
		"task.cancel request task_id is a text string containing the invalid UTF-8 byte 0xff",
		bytesOf("8400016b7461736b2e63616e63656c816261ff"),
	);
	addNegative(
		"negative.sha256_33_bytes",
		"exec stdin InputRef sha256 is 33 bytes instead of 32",
		encodeCbor([
			0,
			30,
			"task.start",
			["t-bad", 1, ["exec", [["argv", []], {}, "", [0, new Uint8Array(33)]]], false, [], 0, 0, ["status", []]],
		]),
	);
	addNegative(
		"negative.null_non_nullable",
		"task.cancel request task_id is null where text is required",
		encodeCbor([0, 29, "task.cancel", [null]]),
	);
	addNegative(
		"negative.task_exit_result_unknown",
		'task.exit result has the tag "exec", which reports no structured result',
		encodeCbor([2, "task.exit", ["t-bad", ["code", 0], false, false, 0, 0, "", ["exec", []]]]),
	);
	addNegative(
		"negative.task_exit_result_map",
		"task.exit result is a free-form map instead of the typed result of the task kind",
		encodeCbor([2, "task.exit", ["t-bad", ["code", 0], false, false, 0, 0, "", new Map([["from", 1]])]]),
	);
	addNegative(
		"negative.task_exit_result_short",
		"task.exit file.read result has 4 elements instead of 5",
		encodeCbor([2, "task.exit", ["t-bad", ["code", 0], false, false, 0, 0, "", ["file.read", [1, 2, true, null]]]]),
	);
	addNegative(
		"negative.int_below_min",
		"task.exit outcome code is -9007199254740992 (-2^53), below the int minimum -(2^53 - 1)",
		encodeCbor([2, "task.exit", ["t-bad", ["code", -9007199254740992n], false, false, 0, 0, ""]]),
	);
	{
		const source = Buffer.from(
			encodeFrame({
				kind: "request",
				id: 27,
				cmd: "task.start",
				body: taskStartWithSpec(
					"t-bad",
					{ kind: "exec", command: { argv: [] }, env: { B: "2" }, cwd: "", stdin: null },
					{ kind: "status" },
				),
			}),
		);
		const needle = Buffer.from("a161426132", "hex");
		const at = source.indexOf(needle);
		if (at < 0) throw new Error("env key-order fixture anchor not found");
		addNegative(
			"negative.env_key_order",
			'exec env map has keys "B" then "A" (non-canonical key order)',
			Buffer.concat([
				source.subarray(0, at),
				Buffer.from("a26142613261416131", "hex"),
				source.subarray(at + needle.length),
			]),
		);
	}
	{
		const source = Buffer.from(
			encodeFrame({
				kind: "request",
				id: 28,
				cmd: "task.start",
				body: taskStartWithSpec(
					"t-bad",
					{ kind: "exec", command: { argv: [] }, env: { "1": "x" }, cwd: "", stdin: null },
					{ kind: "status" },
				),
			}),
		);
		const needle = Buffer.from("a161316178", "hex");
		const at = source.indexOf(needle);
		if (at < 0) throw new Error("env integer-key fixture anchor not found");
		addNegative(
			"negative.env_key_int",
			"exec env map has the integer key 1, but env permits only text keys",
			Buffer.concat([source.subarray(0, at), Buffer.from("a1016178", "hex"), source.subarray(at + needle.length)]),
		);
	}
	// Facts: the map rules are enforced by the schema, the profile and the shells map.
	addNegative(
		"negative.facts_missing_hostname",
		"event facts map without the required hostname key",
		factsEvent(new Map<string, unknown>([["arch", "x86_64"]])),
	);
	addNegative(
		"negative.facts_wrong_type",
		"event facts map whose hostname is the uint 1 instead of text",
		factsEvent(
			new Map<string, unknown>([
				["arch", "x86_64"],
				["hostname", 1],
			]),
		),
	);
	addNegative(
		"negative.facts_shells_without_sh",
		"event facts map whose shells map has bash but no required sh",
		factsEvent(factsMap([["shells", new Map<string, unknown>([["bash", "/usr/bin/bash"]])]])),
	);
	addNegative(
		"negative.facts_not_a_map",
		"event facts body is an array instead of a text-keyed map",
		encodeCbor([2, "facts", ["node-1"]]),
	);
	addNegative(
		"negative.facts_integer_key",
		"event facts map has the integer key 1 among its text keys",
		factsEvent(
			new Map<unknown, unknown>([
				["hostname", "node-1"],
				[1, "x"],
			]),
		),
	);
	addNegative(
		"negative.facts_shells_integer_key",
		"event facts map whose shells map has the integer key 1 among its text keys",
		factsEvent(
			factsMap([
				[
					"shells",
					new Map<unknown, unknown>([
						["sh", "/bin/sh"],
						[1, "x"],
					]),
				],
			]),
		),
	);
	{
		// The body map has two hostname pairs: the profile rejects duplicate keys even though the
		// pairs are adjacent and otherwise in canonical order.
		const canonical = Buffer.from(
			factsEvent(
				new Map<string, unknown>([
					["arch", "x86_64"],
					["hostname", "node-1"],
				]),
			),
		);
		const needle = Buffer.from("a26461726368667838365f363468686f73746e616d65666e6f64652d31", "hex");
		if (canonical.indexOf(needle) < 0) throw new Error("duplicate-key facts fixture anchor not found");
		addNegative(
			"negative.facts_duplicate_key",
			'event facts map has two hostname keys with "node-1"',
			Buffer.concat([
				canonical.subarray(0, canonical.indexOf(needle)),
				Buffer.from(
					"a36461726368667838365f363468686f73746e616d65666e6f64652d3168686f73746e616d65666e6f64652d31",
					"hex",
				),
				canonical.subarray(canonical.indexOf(needle) + needle.length),
			]),
		);
	}
	{
		// arch sorts before hostname here, so the map is not in canonical key order.
		const canonical = Buffer.from(
			factsEvent(
				new Map<string, unknown>([
					["arch", "x86_64"],
					["hostname", "node-1"],
				]),
			),
		);
		const needle = Buffer.from("a26461726368667838365f363468686f73746e616d65666e6f64652d31", "hex");
		if (canonical.indexOf(needle) < 0) throw new Error("key-order facts fixture anchor not found");
		addNegative(
			"negative.facts_key_order",
			"event facts map has hostname before arch (non-canonical key order)",
			Buffer.concat([
				canonical.subarray(0, canonical.indexOf(needle)),
				Buffer.from("a268686f73746e616d65666e6f64652d316461726368667838365f3634", "hex"),
				canonical.subarray(canonical.indexOf(needle) + needle.length),
			]),
		);
	}
	addNegative(
		"negative.request_cmd_too_long",
		"request cmd is 65 ASCII bytes, over the 64-byte limit",
		encodeCbor([0, 26, "a".repeat(65), []]),
	);

	return { positive, negative };
}
