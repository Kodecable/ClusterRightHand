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
 * The returned function ends the subscription for good; it is meant for a
 * `useEffect` cleanup.
 */

export interface SseHandlers {
	/** A named event arrived; `data` is the parsed JSON (or the raw string if it is not JSON). */
	onEvent: (event: string, data: unknown) => void;
	/** The connection opened; `reconnected` is false for the first connection. */
	onOpen?: (reconnected: boolean) => void;
	/** A connection attempt failed (the next one is already scheduled). */
	onError?: (error: unknown) => void;
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
}

const DEFAULT_BASE_DELAY = 1_000;
const DEFAULT_MAX_DELAY = 30_000;

export function subscribeSse({
	url,
	events,
	onEvent,
	onOpen,
	onError,
	baseDelayMs = DEFAULT_BASE_DELAY,
	maxDelayMs = DEFAULT_MAX_DELAY,
	eventSourceFactory,
}: SseOptions): () => void {
	const create =
		eventSourceFactory ?? (typeof EventSource === "undefined" ? null : (target: string) => new EventSource(target));
	if (!create) return () => {};

	let source: EventSource | null = null;
	let closed = false;
	let attempts = 0;
	let everOpened = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

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
			if (closed) return;
			onError?.(error);
			current.close();
			source = null;
			scheduleReconnect();
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
