import { afterEach, describe, expect, test, vi } from "vitest";
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

describe("subscribeSse", () => {
	afterEach(() => {
		vi.useRealTimers();
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

	test("reconnects with backoff after an error and reports the reconnection", () => {
		vi.useFakeTimers();
		const sources: FakeEventSource[] = [];
		const opens: boolean[] = [];
		subscribeSse({
			url: "/api/x",
			events: ["ping"],
			onEvent: () => {},
			onOpen: (reconnected) => opens.push(reconnected),
			baseDelayMs: 100,
			maxDelayMs: 400,
			eventSourceFactory: (url) => {
				const source = new FakeEventSource(url);
				sources.push(source);
				return source as unknown as EventSource;
			},
		});
		expect(sources).toHaveLength(1);
		sources[0]?.emit("open", "");
		expect(opens).toEqual([false]);

		sources[0]?.emit("error", "");
		expect(sources[0]?.closed).toBe(true);
		vi.advanceTimersByTime(99);
		expect(sources).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sources).toHaveLength(2);
		expect(sources[1]?.url).toBe("/api/x");

		sources[1]?.emit("open", "");
		expect(opens).toEqual([false, true]);

		// A successful open resets the delay; a failed attempt then backs off.
		sources[1]?.emit("error", "");
		vi.advanceTimersByTime(99);
		expect(sources).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(sources).toHaveLength(3);

		// This attempt never opened, so the next delay doubles to 200 ms.
		sources[2]?.emit("error", "");
		vi.advanceTimersByTime(199);
		expect(sources).toHaveLength(3);
		vi.advanceTimersByTime(1);
		expect(sources).toHaveLength(4);
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
