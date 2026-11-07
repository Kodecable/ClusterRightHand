import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useSessionEvents } from "./use-session-events";

/** The hook's event source; open and errors can be pushed from a test. */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readonly listeners = new Map<string, Set<(event: Event) => void>>();
	readonly url: string;
	closed = false;

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}

	addEventListener(name: string, listener: (event: Event) => void): void {
		let listeners = this.listeners.get(name);
		if (listeners === undefined) {
			listeners = new Set();
			this.listeners.set(name, listeners);
		}
		listeners.add(listener);
	}

	close(): void {
		this.closed = true;
	}

	emit(name: string): void {
		for (const listener of this.listeners.get(name) ?? []) listener(new Event(name));
	}
}

afterEach(() => {
	FakeEventSource.instances = [];
	vi.unstubAllGlobals();
});

test("reports a terminal stream error and does not reconnect", async () => {
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 404 })),
	);
	const { result } = renderHook(() => useSessionEvents("s1"));

	await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
	const source = FakeEventSource.instances[0] as FakeEventSource;
	act(() => {
		source.emit("error");
	});

	await waitFor(() => expect(result.current.error?.status).toBe(404));
	expect(source.closed).toBe(true);
	expect(FakeEventSource.instances).toHaveLength(1);
});
