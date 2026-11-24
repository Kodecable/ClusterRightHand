/**
 * The command and event registries: every name this implementation knows, with its
 * request/response or body codec. Every required name must be offered in the handshake; a peer
 * missing one is refused (doc/design/protocol.md "Version negotiation"). An optional name is used
 * only when both sides offer it.
 */
import {
	emptyCodec,
	factsCodec,
	helloCodec,
	metricsSnapshotCodec,
	nodeStatusCodec,
	outputAckCodec,
	pingCodec,
	ptyCloseCodec,
	ptyExitedCodec,
	ptyListCodec,
	ptyOpenCodec,
	ptyResizeCodec,
	taskCancelCodec,
	taskExitAckCodec,
	taskExitCodec,
	taskInputCodec,
	taskOutputCodec,
	taskQueryCodec,
	taskStartCodec,
	taskStatusCodec,
	welcomeCodec,
} from "./messages.ts";
import { trustReportCodec } from "./privileged.ts";
import type { Codec, Infer } from "./schema.ts";

export interface CommandDefinition<Q = unknown, R = unknown> {
	readonly request: Codec<Q>;
	readonly response: Codec<R>;
}

/** Every command. */
export const COMMANDS = {
	hello: { request: helloCodec, response: welcomeCodec },
	ping: { request: pingCodec, response: pingCodec },
	"task.start": { request: taskStartCodec, response: emptyCodec },
	"task.input": { request: taskInputCodec, response: emptyCodec },
	"task.cancel": { request: taskCancelCodec, response: emptyCodec },
	"task.query": { request: taskQueryCodec, response: taskStatusCodec },
	"pty.open": { request: ptyOpenCodec, response: emptyCodec },
	"pty.resize": { request: ptyResizeCodec, response: emptyCodec },
	"pty.close": { request: ptyCloseCodec, response: emptyCodec },
	"metrics.collect": { request: emptyCodec, response: metricsSnapshotCodec },
} as const satisfies Record<string, CommandDefinition>;

/** Every event. */
export const EVENTS = {
	"task.output": taskOutputCodec,
	"task.exit": taskExitCodec,
	facts: factsCodec,
	"node.status": nodeStatusCodec,
	"task.output.ack": outputAckCodec,
	"task.exit.ack": taskExitAckCodec,
	"trust.summary": trustReportCodec,
	"pty.exited": ptyExitedCodec,
	"pty.list": ptyListCodec,
} as const satisfies Record<string, Codec<unknown>>;

export type CommandName = keyof typeof COMMANDS;
export type EventName = keyof typeof EVENTS;
export type CommandRequest<C extends CommandName> = Infer<(typeof COMMANDS)[C]["request"]>;
export type CommandResponse<C extends CommandName> = Infer<(typeof COMMANDS)[C]["response"]>;
export type EventBody<E extends EventName> = Infer<(typeof EVENTS)[E]>;

/** Every command and event a handshake must offer: a peer missing one is refused. */
export const REQUIRED_NAMES: readonly string[] = Object.freeze([
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

/**
 * The names an implementation may offer in addition to the required ones. They are negotiated by
 * intersection: a sender uses one only when both sides offered it. The terminal names are optional
 * from minor 1 on, and `metrics.collect` from minor 2, because an older node does not implement them
 * (doc/design/protocol.md "Version negotiation").
 */
export const OPTIONAL_NAMES: readonly string[] = Object.freeze([
	"pty.open",
	"pty.resize",
	"pty.close",
	"pty.exited",
	"pty.list",
	"metrics.collect",
]);

/** The names this implementation offers in a handshake: every required name, then every optional one. */
export function offeredNames(): string[] {
	return [...REQUIRED_NAMES, ...OPTIONAL_NAMES];
}
