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

/** A subscription whose factory records every opened `EventSource`. */
function setup(options: {
	statusProbe?: () => Promise<number | undefined>;
	onError?: (error: unknown) => void;
	onTerminal?: (error: ApiError) => void;
	onOpen?: (reconnected: boolean) => void;
}) {
	const sources: FakeEventSource[] = [];
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
	});
	return sources;
}

describe("subscribeSse", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		setUnauthorizedHandler(null);
	});

	test("dispatches named events with parsed JSON and tolerates raw strings", () => {
		const sources: FakeEventSource[] = [];
		const received: [string, unknown][] = [];
		subscribeSse({
			url: "/api/sessions/stream",
			events: ["upsert", "remove"],
			onEvent: (event, data) => received.push([event, data]),
			eventSourceFactory: (url) => {
				const source = new FakeEventSource(url);
				sources.push(source);
				return source as unknown as EventSource;
			},
		});
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
});
