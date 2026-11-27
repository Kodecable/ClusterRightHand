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
 * A connection can also go quiet without ever firing an `error`: a sleeping
 * laptop, a changed network or a NAT that dropped the flow leaves the socket
 * half open, and the page would then keep the snapshot it had when the socket
 * died. The server pings a quiet stream every 15 s, so a stream that stays
 * silent for `idleTimeoutMs` is reopened, and so is one whose page became
 * visible or whose network came back after that long.
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
	/**
	 * The event a quiet stream carries as a heartbeat (the session routes send `ping`). It counts as activity
	 * and is not passed to `onEvent` unless it is also listed in `events`.
	 */
	heartbeat?: string;
	/** How long a stream may stay silent before it is treated as dead and reopened. */
	idleTimeoutMs?: number;
	/** Test seam: defaults to the global EventSource. */
	eventSourceFactory?: (url: string) => EventSource;
	/** Test seam: defaults to a `HEAD` request against the global fetch. */
	statusProbe?: (url: string) => Promise<number | undefined>;
}

const DEFAULT_BASE_DELAY = 1_000;
const DEFAULT_MAX_DELAY = 30_000;
const DEFAULT_HEARTBEAT = "ping";
/** Two missed heartbeats: a live stream pings every 15 s. */
const DEFAULT_IDLE_TIMEOUT = 45_000;

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
	heartbeat = DEFAULT_HEARTBEAT,
	idleTimeoutMs = DEFAULT_IDLE_TIMEOUT,
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
	/** Whether the current connection opened: only an open stream can go quiet. */
	let connected = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let lastEventAt = Date.now();

	const stopIdleTimer = () => {
		if (idleTimer !== null) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	};

	/** Reopen at once, without the backoff: the cause is a network change, not a failed attempt. */
	const reopen = (reason: string) => {
		if (closed) return;
		stopIdleTimer();
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		const current = source;
		source = null;
		connected = false;
		current?.close();
		attempts = 0;
		// The new attempt starts the silence window afresh, so a second wake (the network and the page coming
		// back together) does not open a third connection.
		lastEventAt = Date.now();
		onError?.(new Error(reason));
		connect();
	};

	/** Restart the silence timer; an event from a live stream keeps resetting it. */
	const armIdleTimer = () => {
		stopIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (closed || source === null) return;
			// Nothing marks a half-open connection: the page would keep the snapshot it had when the socket died,
			// and reconnecting is what produces a fresh one (doc/design/webui.md "Data layer").
			reopen("the event stream went quiet");
		}, idleTimeoutMs);
	};

	const noteActivity = () => {
		lastEventAt = Date.now();
		if (connected) armIdleTimer();
	};

	const fail = async (error: unknown) => {
		stopIdleTimer();
		const status = eventStatus(error) ?? (await statusProbe(url));
		if (closed) return;
		if (status === 401) {
			closed = true;
			notifyUnauthorized();
			onTerminal?.(new ApiError(status, "HTTP 401"));
			return;
		}
		if (status === 403 || status === 404) {
			closed = true;
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
			connected = true;
			noteActivity();
			onOpen?.(reconnected);
		});
		current.addEventListener("error", (error) => {
			if (closed || source !== current) return;
			connected = false;
			current.close();
			source = null;
			void fail(error);
		});
		// The heartbeat is what tells a live quiet stream from a dead one. It is not forwarded unless the caller
		// also asks for it in `events`.
		current.addEventListener(heartbeat, noteActivity);
		for (const name of events) {
			current.addEventListener(name, (event) => {
				noteActivity();
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

	/**
	 * A hidden page can have its connection frozen by the browser. On the way back, a stream that has been
	 * silent for a heartbeat interval or more is reopened rather than trusted, and a retry in flight runs now.
	 */
	const onVisibility = () => {
		if (typeof document === "undefined" || document.visibilityState !== "visible") return;
		if (source === null || Date.now() - lastEventAt >= idleTimeoutMs) reopen("the page became visible again");
	};
	/** A network that came back must not wait out a backoff delay decided while it was gone. */
	const onOnline = () => {
		if (source === null) reopen("the network came back");
	};

	if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
	if (typeof window !== "undefined") window.addEventListener("online", onOnline);

	connect();

	return () => {
		closed = true;
		stopIdleTimer();
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		source?.close();
		source = null;
		if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
		if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
	};
}
