/**
 * The command and event registries: every name this implementation knows, with
 * its request/response or body codec. Protocol 1.0 names are required in the
 * handshake; the 1.1 names of doc/protocol.md#m4提权 are optional, so a 1.0 peer
 * still connects (its commands are the intersection of the two lists).
 */
import {
	emptyCodec,
	factsCodec,
	helloCodec,
	nodeStatusCodec,
	outputAckCodec,
	pingCodec,
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
import {
	localDecisionCodec,
	localRequestCodec,
	localStateCodec,
	localWithdrawCodec,
	revocationsAddCodec,
	trustReportCodec,
} from "./privileged.ts";
import type { Codec, Infer } from "./schema.ts";

export interface CommandDefinition<Q = unknown, R = unknown> {
	readonly request: Codec<Q>;
	readonly response: Codec<R>;
}

/** Every command, 1.0 and 1.1. */
export const COMMANDS = {
	hello: { request: helloCodec, response: welcomeCodec },
	ping: { request: pingCodec, response: pingCodec },
	"task.start": { request: taskStartCodec, response: emptyCodec },
	"task.input": { request: taskInputCodec, response: emptyCodec },
	"task.cancel": { request: taskCancelCodec, response: emptyCodec },
	"task.query": { request: taskQueryCodec, response: taskStatusCodec },
	"revocations.add": { request: revocationsAddCodec, response: emptyCodec },
	"local.request": { request: localRequestCodec, response: localStateCodec },
	"local.withdraw": { request: localWithdrawCodec, response: emptyCodec },
} as const satisfies Record<string, CommandDefinition>;

/** Every event, 1.0 and 1.1. */
export const EVENTS = {
	"task.output": taskOutputCodec,
	"task.exit": taskExitCodec,
	facts: factsCodec,
	"node.status": nodeStatusCodec,
	"task.output.ack": outputAckCodec,
	"task.exit.ack": taskExitAckCodec,
	"trust.summary": trustReportCodec,
	"local.decision": localDecisionCodec,
} as const satisfies Record<string, Codec<unknown>>;

export type CommandName = keyof typeof COMMANDS;
export type EventName = keyof typeof EVENTS;
export type CommandRequest<C extends CommandName> = Infer<(typeof COMMANDS)[C]["request"]>;
export type CommandResponse<C extends CommandName> = Infer<(typeof COMMANDS)[C]["response"]>;
export type EventBody<E extends EventName> = Infer<(typeof EVENTS)[E]>;

/** Every protocol 1.0 command and event; a peer must implement all of them. */
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
]);

/**
 * Names added in protocol 1.1 (doc/protocol.md#m4提权). Optional in the handshake;
 * a 1.0 node that does not offer them is treated as not supporting `forward`.
 */
export const OPTIONAL_NAMES: readonly string[] = Object.freeze([
	"revocations.add",
	"local.request",
	"local.withdraw",
	"trust.summary",
	"local.decision",
]);

/** Every command and event name this implementation knows. */
export const SUPPORTED_NAMES: readonly string[] = Object.freeze([...REQUIRED_NAMES, ...OPTIONAL_NAMES]);
