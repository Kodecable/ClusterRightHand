import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";

/**
 * Wraps the Harness's `Models` so that its one-shot request path is metered. In durable 1.4.0 generation streams
 * (`streamSimple`) while context compaction summarizes with `completeSimple`, and the compaction task is the only
 * caller of `completeSimple` inside a Harness (doc/agent-runtime.md#配额, D92). The request carries the
 * conversation's provider session id, which identifies the session to charge; Auto Review calls its own `Models`
 * and is charged where it runs.
 */
export function meteredModels(
	models: Models,
	onComplete: (providerSessionId: string, message: AssistantMessage) => Promise<void>,
): Models {
	return new Proxy(models, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (property !== "completeSimple") return value.bind(target);
			return async (...args: Parameters<Models["completeSimple"]>) => {
				const message = await target.completeSimple(...args);
				const sessionId = args[2]?.sessionId;
				if (sessionId) await onComplete(sessionId, message);
				return message;
			};
		},
	});
}
