/**
 * Wire types from doc/design/protocol.md. All field names are camelCase; the encoded
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

export const PROTOCOL_MAJOR = 0;
/**
 * An incompatible change bumps the major version and the Noise prologue, so a peer with another
 * major is refused at the handshake (doc/design/protocol.md "Handshake payloads"). The minor version is additive:
 * new commands and events are negotiated through the handshake's `commands` field.
 */
export const PROTOCOL_MINOR = 0;

/**
 * The Noise prologue's version prefix, `"crh/"` followed by the major version
 * (doc/design/protocol.md "Handshake payloads"). The full prologue is this prefix followed by the server's
 * challenge, so a peer with another major fails the Noise handshake itself.
 */
export const NOISE_PROLOGUE_PREFIX = `crh/${PROTOCOL_MAJOR}`;

/**
 * The data connection's Noise prologue prefix, `"crh-data/0"` (doc/design/protocol.md "Data connections").
 * Its own prefix means a data handshake can never be taken for a control one, or the reverse.
 */
export const DATA_NOISE_PROLOGUE_PREFIX = "crh-data/0";

/** One data frame is at most this many bytes, so it fits a Noise message (doc/design/protocol.md "Data connections"). */
export const DATA_CHUNK_BYTES = 32 * 1024;

/** A data connection that delivers no frame for this long fails the transfer. */
export const DATA_IDLE_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Handshake payloads (Noise IK messages, not frames)
// ---------------------------------------------------------------------------

/**
 * The `shells` fact: the sh and bash a node discovered when crha started. `bash` is text, null or
 * absent when the node has none; the encoder omits it (doc/design/protocol.md "Events").
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
		// No bash is encoded as an absent key, not as null (doc/design/protocol.md "Events").
		return shellsMap.encode(value.bash === null ? { ...value, bash: undefined } : value);
	},
	decode(value) {
		return shellsMap.decode(value);
	},
};

/**
 * Facts is the protocol's one map body (doc/design/protocol.md "Events"). hostname is required; every other
 * field is optional and absent when the node did not report it — absent means unknown, not empty.
 * Text keys a peer does not know are ignored; a non-text key is a decode error.
 */
export interface Facts {
	hostname: string;
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
	["offset", uint],
]);
export type OutputAck = Infer<typeof outputAckCodec>;

export const taskStatusCodec = tuple([
	["taskId", text],
	["state", enumOf("running", "exited", "unknown")],
	["outputEnd", uint],
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

/**
 * The page of a `file.read` is at most this many bytes, whole lines only
 * (doc/design/execution.md "Task types"): the node stops at the first line that would not fit.
 */
export const FILE_READ_MAX_BYTES = 50 * 1024;

/**
 * The entries of a `file.list` result must fit the `task.exit` frame, so the node stops listing
 * once their fields reach this many bytes and reports the result as truncated
 * (doc/design/protocol.md "Task results").
 */
export const FILE_LIST_MAX_BYTES = 32 * 1024;

/**
 * The crhs-side end of a transfer (doc/design/protocol.md "Data connections"): the node opens a data
 * connection to crhs for `transfer_id`, a random id crhs generates per dispatch attempt. The union
 * leaves room for presigned URLs and node-to-node endpoints.
 */
export const transferEndpointCodec = union({
	crhs: field("transferId", text),
});
export type TransferEndpoint = Infer<typeof transferEndpointCodec>;

export const taskSpecCodec = union({
	exec: execSpecCodec,
	"file.read": tuple([
		["path", text],
		["startLine", uint],
		["lineCount", uint],
	]),
	"file.write": tuple([
		["path", text],
		["content", inputRefCodec],
		["overwrite", bool],
		["mode", uint],
		["owner", text],
		["group", text],
		["createParentDirs", bool],
	]),
	"file.push": tuple([
		["path", text],
		["size", uint],
		["sha256", sha256],
		["overwrite", bool],
		["mode", uint],
		["owner", text],
		["group", text],
		["endpoint", transferEndpointCodec],
	]),
	"file.pull": tuple([
		["path", text],
		["maxBytes", uint],
		["endpoint", transferEndpointCodec],
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

// ---------------------------------------------------------------------------
// Task results
// ---------------------------------------------------------------------------

/**
 * The page a `file.read` task kept: the lines it holds and whether the scan reached the end of the
 * file (doc/design/execution.md "Task types"). `total` is the file's line count and is present only at the end.
 */
export const fileReadResultCodec = tuple([
	["from", uint],
	["to", uint],
	["eof", bool],
	["total", nullable(uint)],
	["tooLong", bool],
]);
export type FileReadResult = Infer<typeof fileReadResultCodec>;

/** The metadata a `file.stat` task reports (doc/design/protocol.md "Task results"). */
export const fileStatResultCodec = tuple([
	["path", text],
	["type", text],
	["size", int],
	["mode", text],
	["uid", int],
	["gid", int],
	["owner", text],
	["group", text],
	["mtime", text],
	["linkTarget", nullable(text)],
]);
export type FileStatResult = Infer<typeof fileStatResultCodec>;

/** One directory entry of a `file.list` task. */
export const fileListEntryCodec = tuple([
	["name", text],
	["type", text],
	["size", int],
	["mode", text],
	["mtime", text],
]);
export type FileListEntry = Infer<typeof fileListEntryCodec>;

/** The entries a `file.list` task listed, and whether the limit cut the directory short. */
export const fileListResultCodec = tuple([
	["entries", list(fileListEntryCodec)],
	["truncated", bool],
]);
export type FileListResult = Infer<typeof fileListResultCodec>;

/** What a `file.write` task wrote. */
export const fileWriteResultCodec = tuple([
	["bytes", uint],
	["created", bool],
]);
export type FileWriteResult = Infer<typeof fileWriteResultCodec>;

/** What a `file.edit` task replaced. */
export const fileEditResultCodec = tuple([["replacements", uint]]);
export type FileEditResult = Infer<typeof fileEditResultCodec>;

/** What a `file.pull` task sent: the size and SHA-256 of the file's bytes (doc/design/library.md "File plane"). */
export const filePullResultCodec = tuple([
	["size", uint],
	["sha256", sha256],
]);
export type FilePullResult = Infer<typeof filePullResultCodec>;

/**
 * The structured result of a task, carried in `task.exit.result` (doc/design/protocol.md "Task results"). Its
 * tag is the task kind; a kind that reports nothing structured has no branch. The result never
 * travels in the output stream, which keeps the task's text output alone.
 */
export const taskResultCodec = union({
	"file.read": fileReadResultCodec,
	"file.stat": fileStatResultCodec,
	"file.list": fileListResultCodec,
	"file.write": fileWriteResultCodec,
	"file.edit": fileEditResultCodec,
	"file.pull": filePullResultCodec,
});
export type TaskResult = Infer<typeof taskResultCodec>;

export const taskExitCodec = tuple([
	["taskId", text],
	["outcome", outcomeCodec],
	["timedOut", bool],
	["cancelled", bool],
	// The end offset of the task's one output stream (doc/design/protocol.md "Events").
	["outputEnd", uint],
	["outputFile", text],
	// The line count of the output: the same bytes the output file holds (doc/design/protocol.md "Events").
	["outputLines", uint],
	["result", nullable(taskResultCodec)],
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
	["offset", uint],
	["data", bytes],
]);
export type TaskOutput = Infer<typeof taskOutputCodec>;

export const nodeStatusCodec = tuple([
	["nodeId", text],
	["state", enumOf("pending", "active", "rejected")],
	["message", text],
]);
export type NodeStatus = Infer<typeof nodeStatusCodec>;

export const taskExitAckCodec = tuple([["taskId", text]]);
export type TaskExitAck = Infer<typeof taskExitAckCodec>;

// ---------------------------------------------------------------------------
// Data connections (doc/design/protocol.md "Data connections")
// ---------------------------------------------------------------------------

/**
 * The client payload of a data connection's Noise IK handshake: the protocol major first, so a
 * receiver can reject a future major without parsing the rest, then the task and transfer ids crhs
 * checks against the task it dispatched.
 */
export const dataConnectionInitCodec = tuple([
	["protocolMajor", uint],
	["taskId", text],
	["transferId", text],
]);
export type DataConnectionInit = Infer<typeof dataConnectionInitCodec>;

/** The server payload of a data connection's handshake: the protocol major only. */
export const dataConnectionResponseCodec = tuple([["protocolMajor", uint]]);
export type DataConnectionResponse = Infer<typeof dataConnectionResponseCodec>;

/**
 * One data frame after the handshake: a chunk of bytes, the end of the transfer, or an abort with
 * the error code that ended it. Chunks are in order, and the sender stops at `end` or `abort`.
 */
export const dataFrameCodec = union({
	data: field("bytes", bytes),
	end: tuple([]),
	abort: field("code", text),
});
export type DataFrame = Infer<typeof dataFrameCodec>;
