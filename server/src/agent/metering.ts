import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { TimingSink } from "./latency.ts";

/** Reports a metered `completeSimple` call so the runtime can charge it to the owning session (D92, D101). */
export type CompleteMeter = (
	providerSessionId: string,
	message: AssistantMessage,
	context: { readonly messages: readonly unknown[]; readonly systemPrompt?: string },
) => Promise<void>;

/** Whether a partial's block already carries output (a started tool call counts: its arguments may be empty). */
function blockHasContent(block: AssistantMessage["content"][number]): boolean {
	switch (block.type) {
		case "text":
			return block.text !== "";
		case "thinking":
			return block.thinking !== "";
		default:
			return true;
	}
}

/**
 * Whether an event is the first output of the response: a text/thinking/tool-call delta, or a start/end event
 * whose partial already has content. The opening `start` event and an empty `text_start` carry none.
 */
function carriesContent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return true;
		case "done":
		case "error":
			return false;
		default:
			return event.partial.content.some(blockHasContent);
	}
}

/** Records the stream's timing on the sink as its events pass (doc/agent-runtime.md#会话统计). */
function observe(event: AssistantMessageEvent, providerSessionId: string, timing: TimingSink): void {
	if (event.type === "done" || event.type === "error") {
		timing.finish(providerSessionId);
		return;
	}
	if (carriesContent(event)) timing.noteFirst(providerSessionId);
}

/**
 * Forwards a provider stream while observing it. The consumer drives the returned stream exactly as it drove
 * the original: the same events in the same order, the same `result()` (including a source that ended through
 * `end(result)` without a terminal event), and the same abort signal, which reached the original call untouched.
 * The source has already timed its final message (`AssistantMessageEventStream` stamps `durationMs` there), and
 * creating the forwarding stream after the request means it can never overwrite that: its own `#time` skips a
 * message that already has a duration or predates the stream.
 */
function tapStream(
	source: AssistantMessageEventStream,
	providerSessionId: string,
	timing: TimingSink,
): AssistantMessageEventStream {
	const forwarded = createAssistantMessageEventStream();
	void (async () => {
		let terminal = false;
		try {
			for await (const event of source) {
				observe(event, providerSessionId, timing);
				forwarded.push(event);
				if (event.type === "done" || event.type === "error") terminal = true;
			}
		} catch (error) {
			// The protocol reports provider failures as error events, so an iteration error is a broken source.
			// End the forwarded iteration; its result stays pending, as the source's does.
			console.error("metering: observing a generation stream failed:", error);
			forwarded.end();
			return;
		}
		if (terminal) return;
		// A source that ended through `end(result)` without a done/error event: end the forwarded iteration now
		// and let its `result()` resolve with the source's outcome (a source ended through `end()` alone has
		// none, and its result stays pending like this one's).
		forwarded.end();
		void source.result().then((message) => forwarded.end(message));
	})();
	return forwarded;
}

/**
 * Wraps the Harness's `Models` so that its model requests are metered. In durable 1.4.0 generation streams
 * (`streamSimple`) while context compaction summarizes with `completeSimple`, and the compaction task is the only
 * caller of `completeSimple` inside a Harness (doc/agent-runtime.md#配额, D92). The request carries the
 * conversation's provider session id, which identifies the session to charge; Auto Review calls its own `Models`
 * and is charged where it runs. The request (system prompt plus messages) goes along, so the call's input tokens
 * can be estimated from exactly what was sent when the upstream reports no usage (D101).
 *
 * Generation streams are also timed here (doc/agent-runtime.md#会话统计): `begin` at the call, `noteFirst` on
 * the first event carrying content and `finish` at done/error. Timing therefore needs no viewer and records
 * exactly the generation calls the extension's `afterResponse` sees. `completeSimple` (compaction, and title
 * generation and Auto Review through their own registry) starts no entry, so it can never be read as a step's
 * timing; neither can `streamDeferred`, whose polls produce no new generation.
 */
export function meteredModels(models: Models, onComplete: CompleteMeter, timing: () => TimingSink | undefined): Models {
	return new Proxy(models, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (property === "completeSimple") {
				return async (...args: Parameters<Models["completeSimple"]>) => {
					const message = await target.completeSimple(...args);
					const sessionId = args[2]?.sessionId;
					if (sessionId) await onComplete(sessionId, message, args[1]);
					return message;
				};
			}
			if (property === "streamSimple" || property === "stream") {
				return (...args: unknown[]) => {
					const providerSessionId = (args[2] as { sessionId?: string } | undefined)?.sessionId;
					const sink = timing();
					if (!sink || !providerSessionId) return value.apply(target, args);
					sink.begin(providerSessionId);
					let stream: AssistantMessageEventStream;
					try {
						stream = value.apply(target, args) as AssistantMessageEventStream;
					} catch (error) {
						// No stream exists to end; the failure signal must not outlive the call.
						sink.clear(providerSessionId);
						throw error;
					}
					return tapStream(stream, providerSessionId, sink);
				};
			}
			return value.bind(target);
		},
	});
}
