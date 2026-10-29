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
	SUPPORTED_NAMES,
	type TaskStart,
	type TaskStatus,
} from "../src/messages.ts";

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
	groups: ["sudo", "docker"],
	clockOffsetMs: -1234,
};

const FACTS_TEXT =
	'facts=[hostname="node-1", os_id="ubuntu", os_version_id="24.04", os_pretty_name="Ubuntu 24.04 LTS", ' +
	'kernel="6.8.0-31-generic", arch="x86_64", init_system="systemd", package_managers=["apt","snap"], ' +
	'privilege_tools=["sudo"], notes_path="/etc/crh/notes", groups=["sudo","docker"], clock_offset_ms=-1234]';

const COMMANDS_TEXT = `commands=[${SUPPORTED_NAMES.join(",")}]`;
const AUTHORIZATION = bytesOf("00ff");
const SHA_111 = new Uint8Array(32).fill(0x11);
const SHA_222 = new Uint8Array(32).fill(0x22);

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
		protocolMajor: 1,
		protocolMinor: 0,
		commands: [...SUPPORTED_NAMES],
		crhaVersion: "0.1.0-test",
		clientTimeMs: 1700000000000,
		enroll: null,
	};
	addPositive(
		"handshake.init.no-enroll",
		`HandshakeInit protocol_major=1 protocol_minor=0 ${COMMANDS_TEXT} crha_version="0.1.0-test" client_time_ms=1700000000000 enroll=null`,
		encodeCbor(handshakeInitCodec.encode(initNoEnroll)),
	);
	const initEnroll: HandshakeInit = {
		protocolMajor: 1,
		protocolMinor: 0,
		commands: ["hello", "ping"],
		crhaVersion: "0.1.0-test",
		clientTimeMs: 1700000000000,
		enroll: { tokenSecret: "enroll-secret", hostname: "node-1", facts: FACTS },
	};
	addPositive(
		"handshake.init.enroll",
		`HandshakeInit protocol_major=1 protocol_minor=0 commands=[hello,ping] crha_version="0.1.0-test" client_time_ms=1700000000000 enroll=[token_secret="enroll-secret", hostname="node-1", ${FACTS_TEXT}]`,
		encodeCbor(handshakeInitCodec.encode(initEnroll)),
	);
	const responseActive: HandshakeResponse = {
		protocolMajor: 1,
		protocolMinor: 0,
		commands: [...SUPPORTED_NAMES],
		connectionId: "conn-1",
		serverTimeMs: 1700000001234,
		nodeState: "active",
		nodeId: "node-1",
	};
	addPositive(
		"handshake.response.active",
		`HandshakeResponse protocol_major=1 protocol_minor=0 ${COMMANDS_TEXT} connection_id="conn-1" server_time_ms=1700000001234 node_state="active" node_id="node-1"`,
		encodeCbor(handshakeResponseCodec.encode(responseActive)),
	);
	const responsePending: HandshakeResponse = { ...responseActive, nodeState: "pending" };
	addPositive(
		"handshake.response.pending",
		`HandshakeResponse protocol_major=1 protocol_minor=0 ${COMMANDS_TEXT} connection_id="conn-1" server_time_ms=1700000001234 node_state="pending" node_id="node-1"`,
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
		'request id=5 cmd=task.start body=[task_id="t-read", attempt=1, spec=["file.read", [path="/etc/hosts", offset=0, limit=0]], privileged=false, authorizations=[], timeout_ms=0, kill_grace_ms=0, output=["status", []]]',
		{
			kind: "request",
			id: 5,
			cmd: "task.start",
			body: taskStartWithSpec(
				"t-read",
				{ kind: "file.read", path: "/etc/hosts", offset: 0, limit: 0 },
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
		'event task.exit body=[task_id="t-exec-argv", outcome=["code", 0], timed_out=false, cancelled=false, stdout_end=6, stderr_end=0, output_file=""]',
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
			},
		},
	);
	addFrame(
		"event.task.exit.signal",
		'event task.exit body=[task_id="t-exec-shell", outcome=["signal", "TERM"], timed_out=false, cancelled=true, stdout_end=3, stderr_end=0, output_file=""]',
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
			},
		},
	);
	addFrame(
		"event.task.exit.error",
		'event task.exit body=[task_id="t-edit", outcome=["error", [code="internal_error", message="failed"]], timed_out=true, cancelled=false, stdout_end=0, stderr_end=0, output_file="/tmp/out"]',
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
			},
		},
	);
	addFrame("event.facts", `event facts body=${FACTS_TEXT}`, { kind: "event", name: "facts", body: FACTS });
	addFrame("event.node.status", 'event node.status body=[node_id="node-1", state="active", message="approved"]', {
		kind: "event",
		name: "node.status",
		body: { nodeId: "node-1", state: "active", message: "approved" },
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

	return { positive, negative };
}
