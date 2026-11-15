import { describe, expect, it } from "vitest";
import { clusterExtension } from "../src/agent/extension.ts";
import type { ModelPresets } from "../src/agent/model-presets.ts";
import type { AgentRuntime, AgentRuntimeOptions } from "../src/agent/runtime.ts";

/**
 * The rejected-image set is derived from a conversation's transcript and cached per conversation. The cache is
 * bounded: past the cap the oldest conversation's entry is dropped, so its next request derives the set again.
 */
describe("rejected image cache", () => {
	it("bounds the conversations it remembers", async () => {
		let latestEntryIdCalls = 0;
		let transcriptCalls = 0;
		const runtime = {
			latestEntryId: async () => {
				latestEntryIdCalls += 1;
				return 1;
			},
			transcriptEntries: async () => {
				transcriptCalls += 1;
				return [];
			},
			rememberProviderSession: async () => {},
		};
		const extension = clusterExtension(
			{} as AgentRuntimeOptions,
			{ current: runtime as unknown as AgentRuntime },
			{} as ModelPresets,
		);
		const generation = extension.hooks?.find((hook) => hook.task === "pi.generation");
		if (!generation) throw new Error("the cluster extension has no generation hook");
		const beforeRequest = (
			generation.handlers as {
				beforeRequest: (request: { messages: [] }, api: { conversationId: string }) => Promise<unknown>;
			}
		).beforeRequest;

		for (let index = 0; index <= 1000; index++) {
			await beforeRequest({ messages: [] }, { conversationId: `conversation-${index}` });
		}
		expect(transcriptCalls).toBe(1001);

		// The first conversation fell out of the bounded cache, so asking for it derives its set again.
		await beforeRequest({ messages: [] }, { conversationId: "conversation-0" });
		expect(transcriptCalls).toBe(1002);
		expect(latestEntryIdCalls).toBe(1002);
	});
});
