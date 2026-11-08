/**
 * Transport-agnostic RPC peer: commands (request/response) and events over one
 * reliable ordered message stream. Ids are per direction and start at 1.
 */
import { decodeFrame, encodeFrame, errorMessage, type Frame, ProtocolError } from "./frame.ts";
import type { CommandName, CommandRequest, CommandResponse, EventBody, EventName } from "./registry.ts";

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

/**
 * A request was sent but the peer did not answer within its deadline. The id is
 * forgotten: a response that arrives later is ignored. The request may or may not
 * have run on the remote side, so a caller must not retry a non-idempotent command
 * on this error alone.
 */
export class RequestTimeoutError extends Error {
	override name = "RequestTimeoutError";
	readonly cmd: string;
	readonly timeoutMs: number;

	constructor(cmd: string, timeoutMs: number) {
		super(`request ${cmd} timed out after ${timeoutMs} ms`);
		this.cmd = cmd;
		this.timeoutMs = timeoutMs;
	}

	/** Alias for `timeoutMs`, for callers that only need the deadline. */
	get timeout(): number {
		return this.timeoutMs;
	}
}

export type SendFunction = (bytes: Uint8Array) => void | Promise<void>;

export interface RequestOptions {
	/**
	 * Per-request deadline. `0` disables it. Defaults to
	 * `PeerOptions.requestTimeoutMs` (60 s).
	 */
	timeoutMs?: number;
}

/**
 * Default deadline for one request. Every caller-side command round trip is expected
 * to complete well inside this: a forwarded crh-priv request already gives up after
 * 30 s (`DefaultForwardRequestTimeout` in the Go agent), and no command waits for a
 * human or for a whole task run — `local.request` answers `pending` immediately and
 * task results arrive as events. A command that genuinely needs longer can pass
 * `{ timeoutMs }` explicitly (or `0` to wait until close).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Default cap on concurrently running inbound request handlers. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 64;

/** Error code of a request refused because the inbound handler cap is reached. */
export const REQUEST_BUSY_CODE = "busy";

/** How many timed-out request ids are remembered to swallow their late responses. */
const MAX_TIMED_OUT_IDS = 1024;

export interface PeerOptions {
	/** Send one encoded frame. May be async; failures close the connection. */
	send: SendFunction;
	/** Command and event names both sides agreed on during the handshake. */
	negotiated: Iterable<string>;
	/** Reports a throwing event handler; the caller should close the connection. */
	onError?: (error: Error) => void;
	/**
	 * Deadline for a request that does not pass its own. `0` disables timeout
	 * tracking. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}.
	 */
	requestTimeoutMs?: number;
	/**
	 * Maximum inbound request handlers running at once. A request above the cap is
	 * answered immediately with {@link REQUEST_BUSY_CODE} instead of running
	 * its handler. `0` disables the limit. Events are not limited. Defaults to
	 * {@link DEFAULT_MAX_CONCURRENT_REQUESTS}.
	 */
	maxConcurrentRequests?: number;
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
	timer: ReturnType<typeof setTimeout> | undefined;
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
	readonly #requestTimeoutMs: number;
	readonly #maxConcurrentRequests: number;
	#activeRequests = 0;
	#nextId = 1;
	readonly #pending = new Map<number, PendingRequest>();
	/**
	 * Ids whose request timed out. Their response may still be on the wire; it is
	 * dropped instead of being treated as an unknown response id (a fatal protocol
	 * error). Bounded: after many timeouts the oldest tombstone is forgotten, and a
	 * response that arrives that much later is a protocol error again.
	 */
	readonly #timedOut = new Set<number>();
	readonly #requestHandlers = new Map<string, RequestHandler>();
	readonly #eventHandlers = new Map<string, EventHandler>();
	#closed = false;
	#closeReason = "";

	constructor(options: PeerOptions) {
		this.#sendFn = options.send;
		this.#onError = options.onError;
		this.negotiated = new Set(options.negotiated);
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const max = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
		this.#maxConcurrentRequests = max > 0 ? max : Number.POSITIVE_INFINITY;
	}

	/** Send a command and resolve with its success response body. */
	request<C extends CommandName>(
		cmd: C,
		body: CommandRequest<C>,
		options: RequestOptions = {},
	): Promise<CommandResponse<C>> {
		if (this.#closed) return Promise.reject(new ConnectionError(this.#closeReason));
		if (!this.negotiated.has(cmd)) {
			return Promise.reject(new ProtocolError(`command not negotiated: ${cmd}`));
		}
		const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
		const id = this.#nextId++;
		return new Promise<CommandResponse<C>>((resolve, reject) => {
			const pending: PendingRequest = {
				cmd,
				resolve: (value) => resolve(value as CommandResponse<C>),
				reject,
				timer: undefined,
			};
			this.#pending.set(id, pending);
			if (timeoutMs > 0) {
				const timer = setTimeout(() => {
					if (!this.#pending.delete(id)) return;
					pending.timer = undefined;
					this.#rememberTimedOut(id);
					reject(new RequestTimeoutError(cmd, timeoutMs));
				}, timeoutMs);
				// A request alone must not keep the process alive.
				(timer as { unref?: () => void }).unref?.();
				pending.timer = timer;
			}
			try {
				const sent = this.#sendFn(encodeFrame({ kind: "request", id, cmd, body }));
				if (isPromiseLike(sent)) {
					Promise.resolve(sent).catch((err) => {
						if (this.#pending.delete(id)) {
							this.#clearTimer(pending);
							reject(toError(err));
						}
					});
				}
			} catch (err) {
				if (this.#pending.delete(id)) this.#clearTimer(pending);
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
		for (const pending of this.#pending.values()) {
			this.#clearTimer(pending);
			pending.reject(error);
		}
		this.#pending.clear();
		this.#timedOut.clear();
	}

	#clearTimer(pending: PendingRequest): void {
		if (pending.timer === undefined) return;
		clearTimeout(pending.timer);
		pending.timer = undefined;
	}

	#rememberTimedOut(id: number): void {
		this.#timedOut.add(id);
		if (this.#timedOut.size <= MAX_TIMED_OUT_IDS) return;
		const oldest = this.#timedOut.values().next().value;
		if (oldest !== undefined) this.#timedOut.delete(oldest);
	}

	#dispatchRequest(id: number, cmd: string, body: unknown): void {
		const handler = this.#requestHandlers.get(cmd);
		if (!this.negotiated.has(cmd) || handler === undefined) {
			this.#replyError(id, cmd, "unsupported_command", `unsupported command: ${cmd}`);
			return;
		}
		if (this.#activeRequests >= this.#maxConcurrentRequests) {
			// Refuse before running the handler instead of queueing: the sender learns the
			// request was not accepted and may retry, and its request timeout stays short.
			this.#replyError(id, cmd, REQUEST_BUSY_CODE, "too many concurrent requests");
			return;
		}
		this.#activeRequests += 1;
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			this.#activeRequests -= 1;
		};
		let result: unknown;
		try {
			result = handler(body);
		} catch (err) {
			this.#replyHandlerError(id, cmd, err, release);
			return;
		}
		if (isPromiseLike(result)) {
			Promise.resolve(result).then(
				(response) => this.#replyResult(id, cmd, response, release),
				(err) => this.#replyHandlerError(id, cmd, err, release),
			);
		} else {
			this.#replyResult(id, cmd, result, release);
		}
	}

	#dispatchResponse(frame: Extract<Frame, { kind: "response" }>): void {
		const pending = this.#pending.get(frame.id);
		if (pending === undefined) {
			// A response that lost the race against its request's timeout is benign: the
			// caller already got RequestTimeoutError. Any other unknown id is a protocol error.
			if (this.#timedOut.delete(frame.id)) return;
			throw new ProtocolError(`unknown response id: ${frame.id}`);
		}
		if (pending.cmd !== frame.cmd) {
			throw new ProtocolError(`response cmd mismatch for id ${frame.id}: expected ${pending.cmd}, got ${frame.cmd}`);
		}
		this.#pending.delete(frame.id);
		this.#clearTimer(pending);
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

	#replyResult(id: number, cmd: string, result: unknown, done: () => void): void {
		if (result instanceof AfterResponse) {
			this.#replyOkAfter(id, cmd, result.body, result.after, done);
		} else {
			this.#replyOk(id, cmd, result, done);
		}
	}

	#replyOk(id: number, cmd: string, body: unknown, done: () => void): void {
		this.#replySuccess(id, cmd, body, undefined, done);
	}

	/**
	 * Send a success response, then run `after` once the send has returned (or
	 * resolved, for an async send). Nothing runs if the peer is closed or the
	 * send fails; if the success body cannot be encoded, answer with
	 * `internal_error` instead and do not run `after`.
	 */
	#replyOkAfter(id: number, cmd: string, body: unknown, after: () => void, done: () => void): void {
		this.#replySuccess(id, cmd, body, after, done);
	}

	#replySuccess(id: number, cmd: string, body: unknown, after: (() => void) | undefined, done: () => void): void {
		if (this.#closed) {
			done();
			return;
		}
		let bytes: Uint8Array;
		try {
			bytes = encodeFrame({ kind: "response", id, cmd, ok: true, body });
		} catch (err) {
			this.#replyError(id, cmd, "internal_error", err instanceof Error ? err.message : String(err), done);
			return;
		}
		let sent: void | Promise<void>;
		try {
			sent = this.#sendFn(bytes);
		} catch {
			done();
			return;
		}
		if (isPromiseLike(sent)) {
			Promise.resolve(sent).then(
				() => {
					this.#runAfter(after);
					done();
				},
				() => done(),
			);
			return;
		}
		this.#runAfter(after);
		done();
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

	#replyError(id: number, cmd: string, code: string, message: string, done?: () => void): void {
		this.#sendQuietly({ kind: "response", id, cmd, ok: false, error: { code, message: errorMessage(message) } }, done);
	}

	#replyHandlerError(id: number, cmd: string, err: unknown, done: () => void): void {
		if (err instanceof RemoteError) {
			this.#replyError(id, cmd, err.code, err.message, done);
			return;
		}
		// Any other exception may carry SQL, paths or other server internals: log it locally and answer with a
		// generic code. A handler that wants a specific refusal must throw RemoteError.
		console.error(`peer: handler for ${cmd} failed:`, err);
		this.#replyError(id, cmd, "internal_error", "internal server error", done);
	}

	#sendQuietly(frame: Frame, done?: () => void): void {
		if (this.#closed) {
			done?.();
			return;
		}
		let bytes: Uint8Array;
		try {
			bytes = encodeFrame(frame);
		} catch (err) {
			// An error response that cannot be encoded is a bug: close the connection rather
			// than leaving the remote request pending forever.
			this.#onError?.(toError(err));
			done?.();
			return;
		}
		try {
			const sent = this.#sendFn(bytes);
			if (isPromiseLike(sent)) {
				Promise.resolve(sent).then(
					() => done?.(),
					() => done?.(),
				);
			} else {
				done?.();
			}
		} catch {
			// A transport failure is reported by close(); nothing more to do here.
			done?.();
		}
	}
}
