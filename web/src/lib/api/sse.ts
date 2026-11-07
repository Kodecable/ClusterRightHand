import { ApiError, notifyUnauthorized } from "./client";

/**
 * A small Server-Sent-Events subscription with explicit reconnect and
 * exponential backoff.
 *
 * `EventSource` reconnects on its own, but it does so with a browser-controlled
 * delay and it does not tell us when a reconnect succeeded. Closing it on
 * `error` and re-opening ourselves gives the app one place to decide the
 * backoff, to count attempts, and to refetch the first page after a gap (the
 * contract requires that: events missed while disconnected are not replayed).
 *
 * An `EventSource` error does not carry the HTTP status, so a failed attempt is
 * probed with a `HEAD` request before deciding what to do: a lost session
 * (401), a session the viewer may not see (403) or a deleted one (404) is
 * terminal, while network errors and 5xx responses are retried.
 *
 * The returned function ends the subscription for good; it is meant for a
 * `useEffect` cleanup.
 */

export interface SseHandlers {
	/** A named event arrived; `data` is the parsed JSON (or the raw string if it is not JSON). */
	onEvent: (event: string, data: unknown) => void;
	/** The connection opened; `reconnected` is false for the first connection. */
	onOpen?: (reconnected: boolean) => void;
	/** A retryable connection attempt failed (the next one is already scheduled). */
	onError?: (error: unknown) => void;
	/**
	 * The endpoint answered with 401, 403 or 404. The subscription is closed and
	 * no reconnect is scheduled; a 401 also clears the auth store.
	 */
	onTerminal?: (error: ApiError) => void;
}

export interface SseOptions extends SseHandlers {
	url: string;
	/** The named events to listen for (the default `message` event is always ignored). */
	events: readonly string[];
	/** First reconnect delay; doubles per failed attempt. */
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Test seam: defaults to the global EventSource. */
	eventSourceFactory?: (url: string) => EventSource;
	/** Test seam: defaults to a `HEAD` request against the global fetch. */
	statusProbe?: (url: string) => Promise<number | undefined>;
}

const DEFAULT_BASE_DELAY = 1_000;
const DEFAULT_MAX_DELAY = 30_000;

/** The HTTP status of a failed `EventSource`, when the event carries one (tests and future browsers). */
function eventStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
}

/**
 * Ask the endpoint for the status of the failed connection. A `HEAD` request
 * runs the route's access checks but sends no body, so it does not open a
 * second event stream.
 */
async function probeStatus(url: string): Promise<number | undefined> {
	if (typeof fetch === "undefined") return undefined;
	try {
		const response = await fetch(url, {
			method: "HEAD",
			credentials: "same-origin",
			cache: "no-store",
			headers: { accept: "text/event-stream" },
		});
		return response.status;
	} catch {
		return undefined;
	}
}

export function subscribeSse({
	url,
	events,
	onEvent,
	onOpen,
	onError,
	onTerminal,
	baseDelayMs = DEFAULT_BASE_DELAY,
	maxDelayMs = DEFAULT_MAX_DELAY,
	eventSourceFactory,
	statusProbe = probeStatus,
}: SseOptions): () => void {
	const create =
		eventSourceFactory ?? (typeof EventSource === "undefined" ? null : (target: string) => new EventSource(target));
	if (!create) return () => {};

	let source: EventSource | null = null;
	let closed = false;
	let attempts = 0;
	let everOpened = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const fail = async (error: unknown) => {
		const status = eventStatus(error) ?? (await statusProbe(url));
		if (closed) return;
		if (status === 401) {
			notifyUnauthorized();
			onTerminal?.(new ApiError(status, "HTTP 401"));
			return;
		}
		if (status === 403 || status === 404) {
			onTerminal?.(new ApiError(status, `HTTP ${status}`));
			return;
		}
		onError?.(error);
		scheduleReconnect();
	};

	const connect = () => {
		if (closed) return;
		const current = create(url);
		source = current;
		current.addEventListener("open", () => {
			const reconnected = everOpened;
			everOpened = true;
			attempts = 0;
			onOpen?.(reconnected);
		});
		current.addEventListener("error", (error) => {
			if (closed || source !== current) return;
			current.close();
			source = null;
			void fail(error);
		});
		for (const name of events) {
			current.addEventListener(name, (event) => {
				const payload = (event as MessageEvent).data;
				if (typeof payload !== "string") return;
				let data: unknown = payload;
				if (payload !== "") {
					try {
						data = JSON.parse(payload);
					} catch {
						data = payload;
					}
				}
				onEvent(name, data);
			});
		}
	};

	const scheduleReconnect = () => {
		if (closed || timer !== null) return;
		const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempts);
		attempts += 1;
		timer = setTimeout(() => {
			timer = null;
			connect();
		}, delay);
	};

	connect();

	return () => {
		closed = true;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		source?.close();
		source = null;
	};
}
