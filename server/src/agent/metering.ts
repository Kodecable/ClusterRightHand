import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { TimingSink } from "./latency.ts";

/** Reports a metered `completeSimple` call so the runtime can charge it to the owning session. */
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

/** Records the stream's timing on the sink as its events pass (doc/design/agent-runtime.md "Session statistics"). */
function observe(event: AssistantMessageEvent, providerSessionId: string, timing: TimingSink): void {
	if (event.type === "done" || event.type === "error") {
		timing.finish(providerSessionId);
		return;
	}
	if (carriesContent(event)) timing.noteFirst(providerSessionId);
}

/**
 * Replaces an SDK's opaque wrapper message ("Connection error.") with the transport failure's own. The
 * adapter has already reported the error; only its text changes, and only for a failure this request's fetch saw.
 */
function withFailureMessage(message: AssistantMessage, failure: NetworkFailure): AssistantMessage {
	const error = failure.error;
	if (error === undefined || message.stopReason !== "error" || message.errorMessage?.includes(error.message) === true) {
		return message;
	}
	return { ...message, errorMessage: error.message };
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
	failure: NetworkFailure,
): AssistantMessageEventStream {
	const forwarded = createAssistantMessageEventStream();
	void (async () => {
		let terminal = false;
		try {
			for await (const event of source) {
				observe(event, providerSessionId, timing);
				forwarded.push(event.type === "error" ? { ...event, error: withFailureMessage(event.error, failure) } : event);
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
 * The adapters that accept `options.fetch` (node_modules/@earendil-works/pi-ai/dist/api/*.js). The Google
 * adapters throw on a custom fetch and Bedrock does not use fetch, so those keep pi-ai's message.
 */
const CUSTOM_FETCH_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"mistral-conversations",
	"pi-messages",
]);

type FetchOptions = { fetch?: typeof fetch; signal?: AbortSignal };

/** Remembers the transport failure of one request, so it can replace an SDK's opaque wrapper message. */
interface NetworkFailure {
	error: Error | undefined;
}

/** The host a fetch is sent to, for naming it in a network error. */
function requestHost(input: Parameters<typeof fetch>[0]): string {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return new URL(url).host;
}

/** The ` (Cause: message, CODE)` suffix that keeps Node's error class and transport code. */
function causeText(error: unknown): string {
	const cause = (error as { cause?: { name?: string; message?: string; code?: string } }).cause;
	return cause ? ` (${cause.name}: ${cause.message}${cause.code ? `, ${cause.code}` : ""})` : "";
}

/**
 * A transport failure in crhs's words. The original message stays inside the new one, so pi-ai's retry
 * patterns ("terminated", "fetch failed", "socket hang up", ...) still match.
 */
function networkError(host: string, phase: "connecting" | "reading the streamed response", error: unknown): Error {
	const detail = error as { message?: string };
	return new Error(
		`Network error from crhs to ${host} while ${phase}: ${detail?.message ?? String(error)}${causeText(error)}`,
		{ cause: error },
	);
}

/** A user's stop is not a network failure: an AbortError or an aborted request signal passes through. */
function isAbort(error: unknown, signal: AbortSignal | null | undefined): boolean {
	return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

/**
 * Wraps a fetch so a connection or body-stream failure names the host, the phase and the underlying cause
 * (doc/design/agent-runtime.md "Provider network errors"). A successful response's body is forwarded chunk by
 * chunk; an HTTP error response is returned untouched because the provider SDK builds its error from the status.
 */
function networkFetch(fetchFn: typeof fetch, failure: NetworkFailure): typeof fetch {
	return async (input, init) => {
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const host = requestHost(input);
		let response: Response;
		try {
			response = await fetchFn(input, init);
		} catch (error) {
			if (isAbort(error, signal)) throw error;
			failure.error = networkError(host, "connecting", error);
			throw failure.error;
		}
		const source = response.body;
		if (!response.ok || source === null) return response;
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				const reader = source.getReader();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) {
							controller.close();
							return;
						}
						controller.enqueue(value);
					}
				} catch (error) {
					if (isAbort(error, signal)) {
						controller.error(error);
						return;
					}
					failure.error = networkError(host, "reading the streamed response", error);
					controller.error(failure.error);
				}
			},
		});
		return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
}

/** Adds the network-error fetch to a request's options when its adapter accepts one. */
function withNetworkFetch<O extends FetchOptions | undefined>(
	model: { api: string },
	options: O,
	failure: NetworkFailure,
): O {
	if (!CUSTOM_FETCH_APIS.has(model.api)) return options;
	return { ...options, fetch: networkFetch(options?.fetch ?? globalThis.fetch, failure) } as O;
}

/**
 * Wraps the Harness's `Models` so that its model requests are metered. In durable 1.4.0 generation streams
 * (`streamSimple`) while context compaction summarizes with `completeSimple`, and the compaction task is the only
 * caller of `completeSimple` inside a Harness (doc/design/agent-runtime.md "Quota and token accounting"). The request carries the
 * conversation's provider session id, which identifies the session to charge; Auto Review calls its own `Models`
 * and is charged where it runs. The request (system prompt plus messages) goes along, so the call's input tokens
 * can be estimated from exactly what was sent when the upstream reports no usage.
 *
 * Generation streams are also timed here (doc/design/agent-runtime.md "Session statistics"): `begin` at the call, `noteFirst` on
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
					const failure: NetworkFailure = { error: undefined };
					const options = withNetworkFetch(args[0], args[2], failure);
					const result = await target.completeSimple(args[0], args[1], options);
					const message = withFailureMessage(result, failure);
					const sessionId = options?.sessionId;
					if (sessionId) await onComplete(sessionId, message, args[1]);
					return message;
				};
			}
			if (property === "streamSimple" || property === "stream") {
				return (...args: unknown[]) => {
					const failure: NetworkFailure = { error: undefined };
					const callArgs = [
						args[0],
						args[1],
						withNetworkFetch(args[0] as { api: string }, args[2] as FetchOptions | undefined, failure),
					];
					const providerSessionId = (callArgs[2] as { sessionId?: string } | undefined)?.sessionId;
					const sink = timing();
					if (!sink || !providerSessionId) return value.apply(target, callArgs);
					sink.begin(providerSessionId);
					let stream: AssistantMessageEventStream;
					try {
						stream = value.apply(target, callArgs) as AssistantMessageEventStream;
					} catch (error) {
						// No stream exists to end; the failure signal must not outlive the call.
						sink.clear(providerSessionId);
						throw error;
					}
					return tapStream(stream, providerSessionId, sink, failure);
				};
			}
			return value.bind(target);
		},
	});
}
