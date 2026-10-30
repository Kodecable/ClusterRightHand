/**
 * Wire types from doc/protocol.md. All field names are camelCase; the encoded
 * form is a fixed-length array in the order declared here, except Facts, the
 * protocol's one text-keyed map.
 */
import {
	bool,
	bytes,
	type Codec,
	enumOf,
	field,
	type Infer,
	int,
	keyedMap,
	list,
	nullable,
	sha256,
	text,
	textMap,
	tuple,
	uint,
	union,
} from "./schema.ts";

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 1;

// ---------------------------------------------------------------------------
// Handshake payloads (Noise IK messages, not frames)
// ---------------------------------------------------------------------------

/**
 * The `shells` fact: the sh and bash a node discovered when crha started. `bash` is text, null or
 * absent when the node has none; the encoder omits it (doc/protocol.md Facts).
 */
export interface Shells {
	sh: string;
	bash?: string | null;
}

const shellsMap = keyedMap<Shells>("shells", [
	{ wire: "sh", field: "sh", codec: text, required: true },
	{ wire: "bash", field: "bash", codec: nullable(text) },
]);

export const shellsCodec: Codec<Shells> = {
	name: shellsMap.name,
	encode(value) {
		// No bash is encoded as an absent key, not as null (doc/protocol.md Facts).
		return shellsMap.encode(value.bash === null ? { ...value, bash: undefined } : value);
	},
	decode(value) {
		return shellsMap.decode(value);
	},
};

/**
 * Facts is the protocol's one map body (doc/protocol.md Facts). hostname and groups are required;
 * every other field is optional and absent when the node did not report it — absent means unknown,
 * not empty. Text keys a peer does not know are ignored; a non-text key is a decode error.
 */
export interface Facts {
	hostname: string;
	groups: string[];
	osId?: string;
	osVersionId?: string;
	osPrettyName?: string;
	kernel?: string;
	arch?: string;
	initSystem?: string;
	packageManagers?: string[];
	privilegeTools?: string[];
	notesPath?: string;
	clockOffsetMs?: number;
	shells?: Shells;
}

export const factsCodec = keyedMap<Facts>("facts", [
	{ wire: "hostname", field: "hostname", codec: text, required: true },
	{ wire: "groups", field: "groups", codec: list(text), required: true },
	{ wire: "os_id", field: "osId", codec: text },
	{ wire: "os_version_id", field: "osVersionId", codec: text },
	{ wire: "os_pretty_name", field: "osPrettyName", codec: text },
	{ wire: "kernel", field: "kernel", codec: text },
	{ wire: "arch", field: "arch", codec: text },
	{ wire: "init_system", field: "initSystem", codec: text },
	{ wire: "package_managers", field: "packageManagers", codec: list(text) },
	{ wire: "privilege_tools", field: "privilegeTools", codec: list(text) },
	{ wire: "notes_path", field: "notesPath", codec: text },
	{ wire: "clock_offset_ms", field: "clockOffsetMs", codec: int },
	{ wire: "shells", field: "shells", codec: shellsCodec },
]);

export const enrollmentCodec = tuple([
	["tokenSecret", text],
	["hostname", text],
	["facts", factsCodec],
]);
export type Enrollment = Infer<typeof enrollmentCodec>;

export const handshakeInitCodec = tuple([
	["protocolMajor", uint],
	["protocolMinor", uint],
	["commands", list(text)],
	["crhaVersion", text],
	["clientTimeMs", int],
	["enroll", nullable(enrollmentCodec)],
]);
export type HandshakeInit = Infer<typeof handshakeInitCodec>;

export const handshakeResponseCodec = tuple([
	["protocolMajor", uint],
	["protocolMinor", uint],
	["commands", list(text)],
	["connectionId", text],
	["serverTimeMs", int],
	["nodeState", enumOf("active", "pending")],
	["nodeId", text],
]);
export type HandshakeResponse = Infer<typeof handshakeResponseCodec>;

// ---------------------------------------------------------------------------
// Shared bodies
// ---------------------------------------------------------------------------

export const errorCodec = tuple([
	["code", text],
	["message", text],
]);
export type WireError = Infer<typeof errorCodec>;
/** Protocol `Error` (named `WireError` here so it cannot shadow the global). */
export type Error = WireError;

export const outputAckCodec = tuple([
	["taskId", text],
	["stdoutOffset", uint],
	["stderrOffset", uint],
]);
export type OutputAck = Infer<typeof outputAckCodec>;

export const taskStatusCodec = tuple([
	["taskId", text],
	["state", enumOf("running", "exited", "unknown")],
	["stdoutEnd", uint],
	["stderrEnd", uint],
]);
export type TaskStatus = Infer<typeof taskStatusCodec>;

// ---------------------------------------------------------------------------
// Task specs
// ---------------------------------------------------------------------------

export const inputRefCodec = tuple([
	["size", uint],
	["sha256", sha256],
]);
export type InputRef = Infer<typeof inputRefCodec>;

export const commandCodec = union(
	{
		argv: field("argv", list(text)),
		shell: field("shell", text),
	},
	{ untagged: true },
);
export type Command = Infer<typeof commandCodec>;

export const execSpecCodec = tuple([
	["command", commandCodec],
	["env", textMap],
	["cwd", text],
	["stdin", nullable(inputRefCodec)],
]);
export type ExecSpec = Infer<typeof execSpecCodec>;

export const editCodec = tuple([
	["oldText", text],
	["newText", text],
]);
export type Edit = Infer<typeof editCodec>;

export const taskSpecCodec = union({
	exec: execSpecCodec,
	"file.read": tuple([
		["path", text],
		["offset", uint],
		["limit", uint],
	]),
	"file.write": tuple([
		["path", text],
		["content", inputRefCodec],
		["overwrite", bool],
		["mode", uint],
		["owner", text],
		["group", text],
	]),
	"file.edit": tuple([
		["path", text],
		["edits", list(editCodec)],
	]),
	"file.stat": tuple([["path", text]]),
	"file.list": tuple([
		["path", text],
		["limit", uint],
	]),
});
export type TaskSpec = Infer<typeof taskSpecCodec>;

export const outputModeCodec = union({
	full: tuple([
		["spillBytes", uint],
		["spillLines", uint],
	]),
	text: tuple([]),
	status: tuple([]),
});
export type OutputMode = Infer<typeof outputModeCodec>;

export const taskStartCodec = tuple([
	["taskId", text],
	["attempt", uint],
	["spec", taskSpecCodec],
	["privileged", bool],
	["authorizations", list(bytes)],
	["timeoutMs", uint],
	["killGraceMs", uint],
	["output", outputModeCodec],
]);
export type TaskStart = Infer<typeof taskStartCodec>;

export const outcomeCodec = union({
	code: int,
	signal: text,
	error: errorCodec,
});
export type Outcome = Infer<typeof outcomeCodec>;

export const taskExitCodec = tuple([
	["taskId", text],
	["outcome", outcomeCodec],
	["timedOut", bool],
	["cancelled", bool],
	["stdoutEnd", uint],
	["stderrEnd", uint],
	["outputFile", text],
]);
export type TaskExit = Infer<typeof taskExitCodec>;

// ---------------------------------------------------------------------------
// Command bodies
// ---------------------------------------------------------------------------

export const helloCodec = tuple([
	["tasks", list(taskStatusCodec)],
	["taskKinds", list(text)],
	["privilegedMode", text],
]);
export type Hello = Infer<typeof helloCodec>;

export const welcomeCodec = tuple([["acks", list(outputAckCodec)]]);
export type Welcome = Infer<typeof welcomeCodec>;

export const pingCodec = tuple([["seq", uint]]);
export type Ping = Infer<typeof pingCodec>;

export const taskInputCodec = tuple([
	["taskId", text],
	["offset", uint],
	["data", bytes],
]);
export type TaskInput = Infer<typeof taskInputCodec>;

export const taskCancelCodec = tuple([["taskId", text]]);
export type TaskCancel = Infer<typeof taskCancelCodec>;

export const taskQueryCodec = tuple([["taskId", text]]);
export type TaskQuery = Infer<typeof taskQueryCodec>;

export const emptyCodec = tuple([]);
export type Empty = Infer<typeof emptyCodec>;

// ---------------------------------------------------------------------------
// Event bodies
// ---------------------------------------------------------------------------

export const taskOutputCodec = tuple([
	["taskId", text],
	["stream", enumOf("stdout", "stderr")],
	["offset", uint],
	["data", bytes],
]);
export type TaskOutput = Infer<typeof taskOutputCodec>;

export const nodeStatusCodec = tuple([
	["nodeId", text],
	["state", enumOf("pending", "active", "rejected", "disabled")],
	["message", text],
]);
export type NodeStatus = Infer<typeof nodeStatusCodec>;

export const taskExitAckCodec = tuple([["taskId", text]]);
export type TaskExitAck = Infer<typeof taskExitAckCodec>;
