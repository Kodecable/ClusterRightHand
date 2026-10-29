/**
 * Wire types from doc/protocol.md. All field names are camelCase; the encoded
 * form is always a fixed-length array in the order declared here.
 */
import {
	bool,
	bytes,
	type Codec,
	enumOf,
	field,
	type Infer,
	int,
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
export const PROTOCOL_MINOR = 0;

// ---------------------------------------------------------------------------
// Handshake payloads (Noise IK messages, not frames)
// ---------------------------------------------------------------------------

export const factsCodec = tuple([
	["hostname", text],
	["osId", text],
	["osVersionId", text],
	["osPrettyName", text],
	["kernel", text],
	["arch", text],
	["initSystem", text],
	["packageManagers", list(text)],
	["privilegeTools", list(text)],
	["notesPath", text],
	["groups", list(text)],
	["clockOffsetMs", int],
]);
export type Facts = Infer<typeof factsCodec>;

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

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

export interface CommandDefinition<Q = unknown, R = unknown> {
	readonly request: Codec<Q>;
	readonly response: Codec<R>;
}

/** Every 1.0 command. M4-reserved names are deliberately absent. */
export const COMMANDS = {
	hello: { request: helloCodec, response: welcomeCodec },
	ping: { request: pingCodec, response: pingCodec },
	"task.start": { request: taskStartCodec, response: emptyCodec },
	"task.input": { request: taskInputCodec, response: emptyCodec },
	"task.cancel": { request: taskCancelCodec, response: emptyCodec },
	"task.query": { request: taskQueryCodec, response: taskStatusCodec },
} as const satisfies Record<string, CommandDefinition>;

/** Every 1.0 event. M4-reserved names are deliberately absent. */
export const EVENTS = {
	"task.output": taskOutputCodec,
	"task.exit": taskExitCodec,
	facts: factsCodec,
	"node.status": nodeStatusCodec,
	"task.output.ack": outputAckCodec,
	"task.exit.ack": taskExitAckCodec,
} as const satisfies Record<string, Codec<unknown>>;

export type CommandName = keyof typeof COMMANDS;
export type EventName = keyof typeof EVENTS;
export type CommandRequest<C extends CommandName> = Infer<(typeof COMMANDS)[C]["request"]>;
export type CommandResponse<C extends CommandName> = Infer<(typeof COMMANDS)[C]["response"]>;
export type EventBody<E extends EventName> = Infer<(typeof EVENTS)[E]>;

/** All command and event names implemented by protocol 1.0. */
export const SUPPORTED_NAMES: readonly string[] = Object.freeze([...Object.keys(COMMANDS), ...Object.keys(EVENTS)]);
