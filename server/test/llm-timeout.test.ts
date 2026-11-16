import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { LlmAbortedError, LlmTimeoutError, streamSimpleWithTimeouts } from "../src/agent/llm-timeout.ts";

/**
 * The auxiliary model calls (Auto Review, titles) must not hang on a provider that never sends or never
 * finishes: the idle limit resets on every event, thinking included, and an overall limit caps the call
 * (doc/design/agent-runtime.md "Title generation"). The limits are injected so the tests need no fake clock.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stream fed by `pump`; `pump` ends it by calling `done()`. */
function fakeStream(pump: (push: (event: AssistantMessageEvent) => void, done: () => void) => Promise<void>) {
	return () => {
		const stream = createAssistantMessageEventStream();
		const message = fauxAssistantMessage([fauxText("answer")]);
		void pump(
			(event) => stream.push(event),
			() => {
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			},
		).catch((err: unknown) => {
			stream.push({
				type: "error",
				reason: "error",
				error: fauxAssistantMessage([], { stopReason: "error", errorMessage: String(err) }),
			});
			stream.end(fauxAssistantMessage([], { stopReason: "error", errorMessage: String(err) }));
		});
		return stream;
	};
}

const delta = (partial: ReturnType<typeof fauxAssistantMessage>): AssistantMessageEvent => ({
	type: "text_delta",
	contentIndex: 0,
	delta: "x",
	partial,
});

describe("streamSimpleWithTimeouts", () => {
	it("cuts a stream that sends nothing at the idle limit", async () => {
		const open = fakeStream(async () => {
			await sleep(60);
		});
		await expect(streamSimpleWithTimeouts(open, { limits: { idleMs: 20, overallMs: 1_000 } })).rejects.toBeInstanceOf(
			LlmTimeoutError,
		);
	});

	it("cuts a stream that keeps sending but outlives the overall limit", async () => {
		const partial = fauxAssistantMessage([]);
		const open = fakeStream(async (push) => {
			for (;;) {
				push(delta(partial));
				await sleep(5);
			}
		});
		await expect(streamSimpleWithTimeouts(open, { limits: { idleMs: 100, overallMs: 40 } })).rejects.toMatchObject({
			name: "LlmTimeoutError",
			kind: "overall",
		});
	});

	it("resets the idle limit on thinking deltas, so a reasoning model is not stalled", async () => {
		const partial = fauxAssistantMessage([fauxThinking("thinking")]);
		const open = fakeStream(async (push, done) => {
			for (let index = 0; index < 5; index++) {
				push({ type: "thinking_delta", contentIndex: 0, delta: "x", partial });
				await sleep(10);
			}
			done();
		});
		const answer = await streamSimpleWithTimeouts(open, { limits: { idleMs: 25, overallMs: 1_000 } });
		expect(answer.content[0]).toMatchObject({ type: "text", text: "answer" });
	});

	it("passes the caller's abort through as an abort, not a timeout", async () => {
		const controller = new AbortController();
		const open = fakeStream(async (_push, done) => {
			await sleep(60);
			done();
		});
		const call = streamSimpleWithTimeouts(open, {
			limits: { idleMs: 1_000, overallMs: 1_000 },
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 10);
		await expect(call).rejects.toBeInstanceOf(LlmAbortedError);
	});
});
