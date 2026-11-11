/**
 * The command and event registries: every name this implementation knows, with
 * its request/response or body codec. Every name must be offered in the handshake; a peer
 * missing one is refused (doc/design/protocol.md "Handshake payloads").
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
	trustReportCodec,
} from "./privileged.ts";
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
	"local.request": { request: localRequestCodec, response: localStateCodec },
	"local.withdraw": { request: localWithdrawCodec, response: emptyCodec },
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
	"local.decision": localDecisionCodec,
} as const satisfies Record<string, Codec<unknown>>;

export type CommandName = keyof typeof COMMANDS;
export type EventName = keyof typeof EVENTS;
export type CommandRequest<C extends CommandName> = Infer<(typeof COMMANDS)[C]["request"]>;
export type CommandResponse<C extends CommandName> = Infer<(typeof COMMANDS)[C]["response"]>;
export type EventBody<E extends EventName> = Infer<(typeof EVENTS)[E]>;

/** Every command and event, and the names a handshake must offer: a peer missing one is refused. */
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
	"local.request",
	"local.withdraw",
	"trust.summary",
	"local.decision",
]);
