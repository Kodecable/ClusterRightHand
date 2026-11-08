import { describe, expect, test, vi } from "vitest";
import type { EntryRecord, SessionEvent } from "./session-events";
import { initialState, reduceAll } from "./session-reducer";
import { TranscriptStreams } from "./transcript-streams";

const emptySnapshot: SessionEvent = { type: "snapshot", snapshot: { entries: [], tools: [], inbox: [] } };

const assistantEntry = (id: string, text: string): EntryRecord => ({
	id,
	kind: "pi.assistant",
	model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
});

const startText = (text: string): SessionEvent[] => [
	{ type: "message_start", message: { role: "assistant", content: [] } },
	{
		type: "message_update",
		changes: [
			{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
			{ type: "text_delta", contentIndex: 0, delta: text },
		],
	},
];

describe("TranscriptStreams across a reconnect", () => {
	test("a streamed message after a snapshot gets a fresh, unfinished store and key", () => {
		let state = reduceAll(initialState, [emptySnapshot, ...startText("one")]);
		const streams = new TranscriptStreams();
		streams.sync(state);
		const firstKey = state.liveKey;
		expect(firstKey).toBe("live/1");
		const firstStore = streams.text(`${firstKey}/0`);
		firstStore.flush();
		expect(firstStore.getSnapshot()).toBe("one");

		state = reduceAll(state, [{ type: "message_end", entry: assistantEntry("1", "one") }]);
		streams.sync(state);
		expect(firstStore.isDone()).toBe(true);
		const release = vi.spyOn(firstStore, "dispose");

		// The reconnect snapshot shows the same conversation without the stream;
		// the store of the finished message must be released.
		state = reduceAll(state, [emptySnapshot]);
		streams.sync(state);
		expect(release).toHaveBeenCalled();

		state = reduceAll(state, startText("two"));
		streams.sync(state);
		const secondKey = state.liveKey;
		expect(secondKey).toBe("live/2");
		expect(secondKey).not.toBe(firstKey);
		const secondStore = streams.text(`${secondKey}/0`);
		expect(secondStore).not.toBe(firstStore);
		secondStore.flush();
		expect(secondStore.getSnapshot()).toBe("two");
		// `StreamingMarkdown` sees a live message, so it streams and remends.
		expect(secondStore.isDone()).toBe(false);
	});

	test("a snapshot's in-flight generation also starts a fresh store", () => {
		let state = reduceAll(initialState, [emptySnapshot, ...startText("one")]);
		const streams = new TranscriptStreams();
		streams.sync(state);
		const firstStore = streams.text(`${state.liveKey}/0`);
		firstStore.flush();
		state = reduceAll(state, [{ type: "message_end", entry: assistantEntry("1", "one") }]);
		streams.sync(state);
		expect(firstStore.isDone()).toBe(true);

		state = reduceAll(state, [
			{
				type: "snapshot",
				snapshot: {
					entries: [],
					generation: { attempt: 2, message: { role: "assistant", content: [{ type: "text", text: "resumed" }] } },
					tools: [],
					inbox: [],
				},
			},
		]);
		streams.sync(state);
		expect(state.liveKey).toBe("live/2");
		const resumed = streams.text(`${state.liveKey}/0`);
		resumed.flush();
		expect(resumed.getSnapshot()).toBe("resumed");
		expect(resumed).not.toBe(firstStore);
		expect(resumed.isDone()).toBe(false);
	});
});
