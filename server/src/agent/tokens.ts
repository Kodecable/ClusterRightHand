/**
 * Token accounting for the two measures (D101, doc/agent-runtime.md#配额):
 *
 * - the **budget** stops a run: the output tokens of every model call, output only;
 * - the **usage** statistic describes a run: input + output tokens, cache included in the input.
 *
 * Both are estimated from UTF-8 bytes with the same factor when the upstream reports nothing, so the two
 * measures never disagree about a call the provider left unaccounted.
 */

/** Tokens estimated per UTF-8 byte when the upstream reports no usage (D92, D101). */
export const ESTIMATED_TOKENS_PER_BYTE = 0.3;

/** `ceil(bytes × 0.3)`: the one estimate both measures use. */
export function estimateTokens(bytes: number): number {
	if (!Number.isFinite(bytes) || bytes <= 0) return 0;
	return Math.ceil(bytes * ESTIMATED_TOKENS_PER_BYTE);
}

const encoder = new TextEncoder();

/** The parts of an assistant message the accounting reads; a pi-ai `AssistantMessage` satisfies it. */
export interface AccountedContent {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly name?: string;
	readonly arguments?: unknown;
}

/** The usage an upstream may report; every counter is optional in practice. */
export interface AccountedUsage {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}

export interface AccountedMessage {
	readonly usage?: AccountedUsage | null;
	readonly content?: readonly AccountedContent[];
}

/** What one model call costs under both measures, plus the context size of its input. */
export interface CallTokens {
	/** Output tokens, charged to the quota (D92). */
	budget: number;
	/** Input + output tokens, for the statistics measure (D101). */
	usage: number;
	/** Input tokens (input + cache read + cache write) of this call, the context fill (D101). */
	context: number;
}

function count(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** The bytes an answer holds: text, visible reasoning and tool calls (name plus serialized arguments). */
export function outputBytes(content: readonly AccountedContent[]): number {
	let bytes = 0;
	for (const block of content) {
		switch (block.type) {
			case "text":
				if (block.text) bytes += encoder.encode(block.text).length;
				break;
			case "thinking":
				if (block.thinking) bytes += encoder.encode(block.thinking).length;
				break;
			case "toolCall":
				bytes += encoder.encode(block.name ?? "").length;
				bytes += encoder.encode(JSON.stringify(block.arguments ?? null)).length;
				break;
		}
	}
	return bytes;
}

/**
 * The tokens the budget charges for one call (D92): the output the upstream reported (reasoning included),
 * or, when it reported none (`usage` missing, or `output` 0 for a message with content), `ceil(bytes × 0.3)`
 * over the message's text, visible thinking and tool calls. Input and cache tokens are never charged.
 */
export function accountedOutputTokens(message: AccountedMessage): number {
	const output = count(message.usage?.output);
	if (output > 0) return output;
	return estimateTokens(outputBytes(message.content ?? []));
}

/**
 * The tokens of one call's input (D101): the upstream's input + cache read + cache write, or, when it
 * reported none, the estimate from the request context the call sent (`estimatedInput`, in tokens).
 */
export function accountedInputTokens(message: AccountedMessage, estimatedInput: number): number {
	const usage = message.usage;
	if (usage) {
		const input = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
		if (input > 0) return input;
	}
	return Math.max(0, Math.round(estimatedInput));
}

/**
 * What one model call costs under both measures. The output half follows the budget's rule, so a call the
 * provider did not account for is estimated the same way by both measures.
 */
export function callTokens(message: AccountedMessage, estimatedInput: number): CallTokens {
	const budget = accountedOutputTokens(message);
	const context = accountedInputTokens(message, estimatedInput);
	return { budget, usage: context + budget, context };
}

/**
 * The bytes of a request's context, for estimating its input tokens when the upstream reports no usage (D101):
 * the JSON of what the call actually sent. A generation passes the serialized `messages` durable's
 * `beforeRequest` exposes; that hook does not see the system prompt or the tool declarations, so neither is
 * measured. A compaction or a review passes the request object it gives `completeSimple`, i.e. the system prompt
 * plus the messages. Anything that cannot be serialized counts as 0.
 */
export function requestBytes(context: unknown): number {
	try {
		const json = JSON.stringify(context);
		return json === undefined ? 0 : encoder.encode(json).length;
	} catch {
		return 0;
	}
}

/** The estimated input tokens of a request whose context is `context`. */
export function estimateRequestTokens(context: unknown): number {
	return estimateTokens(requestBytes(context));
}

/**
 * The input estimate of each conversation's in-flight request, held from `beforeRequest` until its response.
 * There is one entry per conversation: a retry overwrites the last estimate, and `take` drops it when the
 * response reads it, so a request that fails without a response cannot leave more than one entry per
 * conversation behind.
 */
export class RequestEstimates {
	readonly #byConversation = new Map<string, number>();

	set(conversationId: string, tokens: number): void {
		this.#byConversation.set(conversationId, tokens);
	}

	/** The estimate of this conversation's current request, forgetting it: the next request starts from scratch. */
	take(conversationId: string): number {
		const tokens = this.#byConversation.get(conversationId) ?? 0;
		this.#byConversation.delete(conversationId);
		return tokens;
	}

	/** How many conversations hold an estimate; at most one entry each. */
	get size(): number {
		return this.#byConversation.size;
	}
}
