import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, setUnauthorizedHandler } from "./client";
import { subscribeSse } from "./sse";

class FakeEventSource {
	readonly url: string;
	closed = false;
	private readonly listeners = new Map<string, Set<(event: MessageEvent | Event) => void>>();

	constructor(url: string) {
		this.url = url;
	}

	addEventListener(type: string, listener: (event: Event) => void): void {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener as (event: Event) => void);
		this.listeners.set(type, set);
	}

	close(): void {
		this.closed = true;
	}

	emit(type: string, data: string): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data } as MessageEvent);
		}
	}
}

/** Let the asynchronous status probe resolve (and any timer it scheduled run). */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

/** Every subscription opened by a test, ended before the next one so no listener or timer outlives it. */
const disposers: (() => void)[] = [];

/** The server's heartbeat interval, and the window the client tolerates without one. */
const IDLE_TIMEOUT = 45_000;

/** A subscription whose factory records every opened `EventSource`. */
function setup(options: {
	statusProbe?: () => Promise<number | undefined>;
	onError?: (error: unknown) => void;
	onTerminal?: (error: ApiError) => void;
	onOpen?: (reconnected: boolean) => void;
}) {
	const sources: FakeEventSource[] = [];
	disposers.push(
		subscribeSse({
			url: "/api/x",
			events: ["ping"],
			onEvent: () => {},
			baseDelayMs: 100,
			maxDelayMs: 400,
			eventSourceFactory: (url) => {
				const source = new FakeEventSource(url);
				sources.push(source);
				return source as unknown as EventSource;
			},
			...options,
		}),
	);
	return sources;
}

describe("subscribeSse", () => {
	afterEach(() => {
		for (const close of disposers.splice(0)) close();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		setUnauthorizedHandler(null);
	});

	test("dispatches named events with parsed JSON and tolerates raw strings", () => {
		const sources: FakeEventSource[] = [];
		const received: [string, unknown][] = [];
		disposers.push(
			subscribeSse({
				url: "/api/sessions/stream",
				events: ["upsert", "remove"],
				onEvent: (event, data) => received.push([event, data]),
				eventSourceFactory: (url) => {
					const source = new FakeEventSource(url);
					sources.push(source);
					return source as unknown as EventSource;
				},
			}),
		);
		sources[0]?.emit("upsert", '{"id":"s1"}');
		sources[0]?.emit("remove", "not json");
		expect(received).toEqual([
			["upsert", { id: "s1" }],
			["remove", "not json"],
		]);
	});

	test("reconnects with backoff after a retryable error and reports the reconnection", async () => {
		vi.useFakeTimers();
		const opens: boolean[] = [];
		const sources = setup({ statusProbe: async () => 503, onOpen: (reconnected) => opens.push(reconnected) });
		expect(sources).toHaveLength(1);
		sources[0]?.emit("open", "");
		expect(opens).toEqual([false]);

		sources[0]?.emit("error", "");
		expect(sources[0]?.closed).toBe(true);
		await flush();
		vi.advanceTimersByTime(99);
		expect(sources).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sources).toHaveLength(2);
		expect(sources[1]?.url).toBe("/api/x");

		sources[1]?.emit("open", "");
		expect(opens).toEqual([false, true]);

		// A successful open resets the delay; a failed attempt then backs off.
		sources[1]?.emit("error", "");
		await flush();
		vi.advanceTimersByTime(99);
		expect(sources).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(sources).toHaveLength(3);

		// This attempt never opened, so the next delay doubles to 200 ms.
		sources[2]?.emit("error", "");
		await flush();
		vi.advanceTimersByTime(199);
		expect(sources).toHaveLength(3);
		vi.advanceTimersByTime(1);
		expect(sources).toHaveLength(4);
	});

	test("stops on 401 and reports the lost session to the auth store", async () => {
		vi.useFakeTimers();
		const unauthorized = vi.fn();
		setUnauthorizedHandler(unauthorized);
		const terminal: ApiError[] = [];
		const failed: unknown[] = [];
		const sources = setup({
			statusProbe: async () => 401,
			onError: (error) => failed.push(error),
			onTerminal: (error) => terminal.push(error),
		});

		sources[0]?.emit("error", "");
		await flush();

		expect(sources[0]?.closed).toBe(true);
		expect(unauthorized).toHaveBeenCalledTimes(1);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toBeInstanceOf(ApiError);
		expect(terminal[0]?.status).toBe(401);
		// A terminal status does not schedule another attempt.
		expect(failed).toHaveLength(0);
		vi.advanceTimersByTime(10_000);
		expect(sources).toHaveLength(1);
	});

	test("stops on 403 and surfaces a terminal error", async () => {
		vi.useFakeTimers();
		const unauthorized = vi.fn();
		setUnauthorizedHandler(unauthorized);
		const terminal: ApiError[] = [];
		const sources = setup({ statusProbe: async () => 403, onTerminal: (error) => terminal.push(error) });

		sources[0]?.emit("error", "");
		await flush();

		expect(sources[0]?.closed).toBe(true);
		expect(unauthorized).not.toHaveBeenCalled();
		expect(terminal[0]?.status).toBe(403);
		vi.advanceTimersByTime(10_000);
		expect(sources).toHaveLength(1);
	});

	test("stops on 404 and surfaces a terminal error", async () => {
		vi.useFakeTimers();
		const terminal: ApiError[] = [];
		const sources = setup({ statusProbe: async () => 404, onTerminal: (error) => terminal.push(error) });

		sources[0]?.emit("error", "");
		await flush();

		expect(sources[0]?.closed).toBe(true);
		expect(terminal[0]?.status).toBe(404);
		vi.advanceTimersByTime(10_000);
		expect(sources).toHaveLength(1);
	});

	test("retries when the status probe cannot determine a status", async () => {
		vi.useFakeTimers();
		const failed: unknown[] = [];
		const terminal: ApiError[] = [];
		const sources = setup({
			statusProbe: async () => undefined,
			onError: (error) => failed.push(error),
			onTerminal: (error) => terminal.push(error),
		});

		sources[0]?.emit("error", "");
		await flush();

		expect(failed).toHaveLength(1);
		expect(terminal).toHaveLength(0);
		vi.advanceTimersByTime(100);
		expect(sources).toHaveLength(2);
	});

	test("probes a failed connection with HEAD before deciding to retry", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () => new Response(null, { status: 502 }));
		vi.stubGlobal("fetch", fetchMock);
		const sources = setup({});

		sources[0]?.emit("error", "");
		await flush();

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/x",
			expect.objectContaining({ method: "HEAD", credentials: "same-origin" }),
		);
		vi.advanceTimersByTime(100);
		expect(sources).toHaveLength(2);
	});

	test("closing ends the subscription for good", () => {
		vi.useFakeTimers();
		const sources: FakeEventSource[] = [];
		const close = subscribeSse({
			url: "/api/x",
			events: ["ping"],
			onEvent: () => {},
			baseDelayMs: 10,
			eventSourceFactory: (url) => {
				const source = new FakeEventSource(url);
				sources.push(source);
				return source as unknown as EventSource;
			},
		});
		close();
		expect(sources[0]?.closed).toBe(true);
		vi.advanceTimersByTime(10_000);
		expect(sources).toHaveLength(1);
	});

	test("reopens a stream that went quiet without an error", () => {
		vi.useFakeTimers();
		const failed: unknown[] = [];
		const sources = setup({ onError: (error) => failed.push(error) });
		sources[0]?.emit("open", "");

		vi.advanceTimersByTime(IDLE_TIMEOUT - 1);
		expect(sources).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sources[0]?.closed).toBe(true);
		expect(sources).toHaveLength(2);
		expect(failed).toHaveLength(1);
	});

	test("keeps a quiet stream alive while its heartbeat arrives", () => {
		vi.useFakeTimers();
		const sources = setup({});
		sources[0]?.emit("open", "");

		// The server pings every 15 s; three pings across a minute are three quiet gaps, none too long.
		for (let ping = 0; ping < 4; ping++) {
			vi.advanceTimersByTime(15_000);
			sources[0]?.emit("ping", "");
		}
		expect(sources).toHaveLength(1);
	});

	test("reopens a silent stream when the page becomes visible again", () => {
		vi.useFakeTimers();
		const sources = setup({});
		sources[0]?.emit("open", "");

		// A hidden page has its timers frozen, so the clock moves without the silence timer running: only the
		// visibility change can notice that the stream is stale.
		vi.setSystemTime(Date.now() + 2 * IDLE_TIMEOUT);
		document.dispatchEvent(new Event("visibilitychange"));

		expect(sources[0]?.closed).toBe(true);
		expect(sources).toHaveLength(2);
	});

	test("reconnects at once when the network comes back during a retry", async () => {
		vi.useFakeTimers();
		const sources = setup({ statusProbe: async () => 503 });

		sources[0]?.emit("error", "");
		await flush();
		expect(sources).toHaveLength(1);

		window.dispatchEvent(new Event("online"));
		expect(sources).toHaveLength(2);
	});
});
