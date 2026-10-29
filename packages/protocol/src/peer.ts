/**
 * Transport-agnostic RPC peer: commands (request/response) and events over one
 * reliable ordered message stream. Ids are per direction and start at 1.
 */
import { decodeFrame, encodeFrame, errorMessage, type Frame, ProtocolError } from "./frame.ts";
import type { CommandName, CommandRequest, CommandResponse, EventBody, EventName } from "./messages.ts";

export class RemoteError extends Error {
	override name = "RemoteError";
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export class ConnectionError extends Error {
	override name = "ConnectionError";
	readonly reason: string;

	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}

export type SendFunction = (bytes: Uint8Array) => void | Promise<void>;

export interface PeerOptions {
	/** Send one encoded frame. May be async; failures close the connection. */
	send: SendFunction;
	/** Command and event names both sides agreed on during the handshake. */
	negotiated: Iterable<string>;
	/** Reports a throwing event handler; the caller should close the connection. */
	onError?: (error: Error) => void;
}

/**
 * Marks a success response whose `after` callback must run only once the
 * response frame has been sent. A `task.start` handler returns this so the
 * task's events cannot overtake the success response.
 */
export class AfterResponse<T> {
	readonly #body: T;
	readonly #after: () => void;

	constructor(body: T, after: () => void) {
		this.#body = body;
		this.#after = after;
	}

	get body(): T {
		return this.#body;
	}

	get after(): () => void {
		return this.#after;
	}
}

/** Wrap a success response body with a callback to run after it is sent. */
export function afterResponse<T>(body: T, after: () => void): AfterResponse<T> {
	return new AfterResponse(body, after);
}

interface PendingRequest {
	readonly cmd: string;
	readonly resolve: (body: unknown) => void;
	readonly reject: (error: Error) => void;
}

type RequestHandler = (body: unknown) => unknown;
type EventHandler = (body: unknown) => unknown;

type HandlerResult<C extends CommandName> = CommandResponse<C> | AfterResponse<CommandResponse<C>>;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export class Peer {
	readonly negotiated: ReadonlySet<string>;
	readonly #sendFn: SendFunction;
	readonly #onError: ((error: Error) => void) | undefined;
	#nextId = 1;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #requestHandlers = new Map<string, RequestHandler>();
	readonly #eventHandlers = new Map<string, EventHandler>();
	#closed = false;
	#closeReason = "";

	constructor(options: PeerOptions) {
		this.#sendFn = options.send;
		this.#onError = options.onError;
		this.negotiated = new Set(options.negotiated);
	}

	/** Send a command and resolve with its success response body. */
	request<C extends CommandName>(cmd: C, body: CommandRequest<C>): Promise<CommandResponse<C>> {
		if (this.#closed) return Promise.reject(new ConnectionError(this.#closeReason));
		if (!this.negotiated.has(cmd)) {
			return Promise.reject(new ProtocolError(`command not negotiated: ${cmd}`));
		}
		const id = this.#nextId++;
		return new Promise<CommandResponse<C>>((resolve, reject) => {
			this.#pending.set(id, {
				cmd,
				resolve: (value) => resolve(value as CommandResponse<C>),
				reject,
			});
			try {
				const sent = this.#sendFn(encodeFrame({ kind: "request", id, cmd, body }));
				if (isPromiseLike(sent)) {
					Promise.resolve(sent).catch((err) => {
						if (this.#pending.delete(id)) reject(toError(err));
					});
				}
			} catch (err) {
				this.#pending.delete(id);
				reject(toError(err));
			}
		});
	}

	/** Register the handler for an inbound command; responses may be async. */
	onRequest<C extends CommandName>(
		cmd: C,
		handler: (body: CommandRequest<C>) => HandlerResult<C> | Promise<HandlerResult<C>>,
	): void {
		this.#requestHandlers.set(cmd, handler as RequestHandler);
	}

	onEvent<E extends EventName>(name: E, handler: (body: EventBody<E>) => void | Promise<void>): void {
		this.#eventHandlers.set(name, handler as EventHandler);
	}

	/** Send an event. Only negotiated event names may be emitted. */
	emit<E extends EventName>(name: E, body: EventBody<E>): void {
		if (this.#closed) throw new ConnectionError(this.#closeReason);
		if (!this.negotiated.has(name)) throw new ProtocolError(`event not negotiated: ${name}`);
		const sent = this.#sendFn(encodeFrame({ kind: "event", name, body }));
		if (isPromiseLike(sent)) Promise.resolve(sent).catch(() => {});
	}

	/**
	 * Feed one received message. Throws ProtocolError on any protocol
	 * violation; the caller is expected to close the connection then.
	 */
	receive(bytes: Uint8Array): void {
		if (this.#closed) throw new ConnectionError("peer is closed");
		const frame = decodeFrame(bytes);
		switch (frame.kind) {
			case "request":
				this.#dispatchRequest(frame.id, frame.cmd, frame.body);
				return;
			case "request.unsupported":
				this.#replyError(frame.id, frame.cmd, "unsupported_command", `unsupported command: ${frame.cmd}`);
				return;
			case "response":
				this.#dispatchResponse(frame);
				return;
			case "event":
				this.#dispatchEvent(frame.name, frame.body);
				return;
		}
	}

	/** Fail every pending request with a connection error. */
	close(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeReason = reason;
		const error = new ConnectionError(reason);
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	#dispatchRequest(id: number, cmd: string, body: unknown): void {
		const handler = this.#requestHandlers.get(cmd);
		if (!this.negotiated.has(cmd) || handler === undefined) {
			this.#replyError(id, cmd, "unsupported_command", `unsupported command: ${cmd}`);
			return;
		}
		let result: unknown;
		try {
			result = handler(body);
		} catch (err) {
			this.#replyHandlerError(id, cmd, err);
			return;
		}
		if (isPromiseLike(result)) {
			Promise.resolve(result).then(
				(response) => this.#replyResult(id, cmd, response),
				(err) => this.#replyHandlerError(id, cmd, err),
			);
		} else {
			this.#replyResult(id, cmd, result);
		}
	}

	#dispatchResponse(frame: Extract<Frame, { kind: "response" }>): void {
		const pending = this.#pending.get(frame.id);
		if (pending === undefined) throw new ProtocolError(`unknown response id: ${frame.id}`);
		if (pending.cmd !== frame.cmd) {
			throw new ProtocolError(`response cmd mismatch for id ${frame.id}: expected ${pending.cmd}, got ${frame.cmd}`);
		}
		this.#pending.delete(frame.id);
		if (frame.ok) {
			pending.resolve(frame.body);
		} else {
			pending.reject(new RemoteError(frame.error.code, frame.error.message));
		}
	}

	#dispatchEvent(name: string, body: unknown): void {
		if (!this.negotiated.has(name)) throw new ProtocolError(`event not negotiated: ${name}`);
		const handler = this.#eventHandlers.get(name);
		if (handler === undefined) throw new ProtocolError(`event has no handler: ${name}`);
		try {
			const result = handler(body);
			if (isPromiseLike(result)) {
				Promise.resolve(result).catch((err) => this.#reportEventError(err));
			}
		} catch (err) {
			this.#reportEventError(err);
		}
	}

	#reportEventError(error: unknown): void {
		this.#onError?.(toError(error));
	}

	#replyResult(id: number, cmd: string, result: unknown): void {
		if (result instanceof AfterResponse) {
			this.#replyOkAfter(id, cmd, result.body, result.after);
		} else {
			this.#replyOk(id, cmd, result);
		}
	}

	#replyOk(id: number, cmd: string, body: unknown): void {
		this.#replySuccess(id, cmd, body);
	}

	/**
	 * Send a success response, then run `after` once the send has returned (or
	 * resolved, for an async send). Nothing runs if the peer is closed or the
	 * send fails; if the success body cannot be encoded, answer with
	 * `internal_error` instead and do not run `after`.
	 */
	#replyOkAfter(id: number, cmd: string, body: unknown, after: () => void): void {
		this.#replySuccess(id, cmd, body, after);
	}

	#replySuccess(id: number, cmd: string, body: unknown, after?: () => void): void {
		if (this.#closed) return;
		let bytes: Uint8Array;
		try {
			bytes = encodeFrame({ kind: "response", id, cmd, ok: true, body });
		} catch (err) {
			this.#replyError(id, cmd, "internal_error", err instanceof Error ? err.message : String(err));
			return;
		}
		let sent: void | Promise<void>;
		try {
			sent = this.#sendFn(bytes);
		} catch {
			return;
		}
		if (isPromiseLike(sent)) {
			Promise.resolve(sent).then(
				() => {
					this.#runAfter(after);
				},
				() => {},
			);
			return;
		}
		this.#runAfter(after);
	}

	/** A throwing after-response hook is a handler bug: report it, never throw out of receive(). */
	#runAfter(after: (() => void) | undefined): void {
		if (this.#closed || after === undefined) return;
		try {
			after();
		} catch (err) {
			this.#onError?.(toError(err));
		}
	}

	#replyError(id: number, cmd: string, code: string, message: string): void {
		this.#sendQuietly({ kind: "response", id, cmd, ok: false, error: { code, message: errorMessage(message) } });
	}

	#replyHandlerError(id: number, cmd: string, err: unknown): void {
		if (err instanceof RemoteError) {
			this.#replyError(id, cmd, err.code, err.message);
			return;
		}
		const text = err instanceof Error ? err.message : String(err);
		this.#replyError(id, cmd, "internal_error", text);
	}

	#sendQuietly(frame: Frame): void {
		if (this.#closed) return;
		let bytes: Uint8Array;
		try {
			bytes = encodeFrame(frame);
		} catch (err) {
			// An error response that cannot be encoded is a bug: close the connection rather
			// than leaving the remote request pending forever.
			this.#onError?.(toError(err));
			return;
		}
		try {
			const sent = this.#sendFn(bytes);
			if (isPromiseLike(sent)) Promise.resolve(sent).catch(() => {});
		} catch {
			// A transport failure is reported by close(); nothing more to do here.
		}
	}
}
