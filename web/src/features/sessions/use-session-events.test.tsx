import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { initialState, reduceAll } from "./session-reducer";
import { structureKey, useSessionEvents } from "./use-session-events";

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

test("structureKey follows details changes, not streamed text or tool output", () => {
	let state = reduceAll(initialState, [
		{
			type: "snapshot",
			snapshot: {
				entries: [],
				tools: [{ callId: "c1", name: "exec", status: "running", output: "starting" }],
				inbox: [],
			},
		},
		{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
	]);
	const base = structureKey(state);

	// The streaming text and a running tool's output live outside the structure key.
	state = reduceAll(state, [
		{
			type: "message_update",
			changes: [{ type: "text_delta", contentIndex: 0, delta: "hello" }],
		},
		{ type: "tool_execution_update", toolCallId: "c1", toolName: "exec", output: { append: "line 1\n" } },
	]);
	expect(structureKey(state)).toBe(base);

	// Details are shown on the tool card, so a details-only batch must change the key.
	state = reduceAll(state, [
		{
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "exec",
			details: { state: "awaiting_approval", approval_url: "http://x/#/approvals/tasks/t1" },
		},
	]);
	const withDetails = structureKey(state);
	expect(withDetails).not.toBe(base);

	// Repeating the same details value (a new object, same JSON) is not a structural
	// change: the old JSON.stringify key did not change either.
	state = reduceAll(state, [
		{
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "exec",
			details: { state: "awaiting_approval", approval_url: "http://x/#/approvals/tasks/t1" },
		},
	]);
	expect(structureKey(state)).toBe(withDetails);

	// A real details change does.
	state = reduceAll(state, [
		{ type: "tool_execution_update", toolCallId: "c1", toolName: "exec", details: { state: "done" } },
	]);
	expect(structureKey(state)).not.toBe(withDetails);
});
