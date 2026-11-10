import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { DEFAULT_TITLE_PROMPT, TITLE_PROTOCOL } from "./model-presets.ts";
import type { ModelRef } from "./models.ts";
import { chargeCall, exhaustedLevel } from "./quota.ts";
import type { RuntimeHost } from "./runtime-core.ts";
import { conversationOf } from "./runtime-core.ts";
import { callTokens, estimateRequestTokens } from "./tokens.ts";

/**
 * Session title generation (doc/design/agent-runtime.md "Title generation"). When a root session's run ends and its title is
 * still pending, one background model call turns the latest user input and that run's final answer into a title.
 * The call is charged like Auto Review, never moves the context fill, and a failure only leaves the session
 * pending for the next run. At most one generation runs per session; the in-flight set is memory-only, so a
 * restart simply waits for the next run end.
 */

/** The full title system prompt: the custom prompt when set, else the default, then the fixed protocol. */
export function titleSystemPrompt(custom: string | null | undefined): string {
	return `${custom ?? DEFAULT_TITLE_PROMPT}\n\n${TITLE_PROTOCOL}`;
}

/** The title's maximum length, in code points. */
export const TITLE_MAX_CHARS = 60;

/** The input texts are cut to this many code points before they are sent. */
export const TITLE_INPUT_MAX_CHARS = 2000;

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
	['"', '"'],
	["'", "'"],
	["“", "”"],
	["‘", "’"],
	["「", "」"],
	["『", "』"],
	["(", ")"],
	["[", "]"],
	["（", "）"],
	["【", "】"],
];

/** Punctuation a title may end in after the model adds a sentence period or a closing quote. */
const TRAILING_PUNCTUATION = new Set([
	".",
	",",
	";",
	":",
	"!",
	"?",
	"…",
	"。",
	"，",
	"；",
	"：",
	"！",
	"？",
	"、",
	"·",
]);

/** Quote marks that may wrap a title without a distinct closing character. */
const QUOTES = new Set(['"', "'", "“", "”", "‘", "’", "「", "」", "『", "』"]);

function stripOnce(value: string): string {
	const trimmed = value.trim();
	for (const [open, close] of QUOTE_PAIRS) {
		if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
			return trimmed.slice(open.length, trimmed.length - close.length).trim();
		}
	}
	let result = trimmed;
	while (result.length > 0 && TRAILING_PUNCTUATION.has(result.at(-1) ?? "")) result = result.slice(0, -1).trimEnd();
	while (result.length > 0 && QUOTES.has(result.at(-1) ?? "")) result = result.slice(0, -1).trimEnd();
	while (result.length > 0 && QUOTES.has(result[0] ?? "")) result = result.slice(1).trimStart();
	return result;
}

/**
 * The title a model answer carries: its first non-empty line, with surrounding quotes/brackets, leading quote
 * marks and trailing punctuation removed, then cut to 60 code points. Undefined when nothing is left.
 */
export function sanitizeTitle(answer: string): string | undefined {
	const line = answer
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.find((entry) => entry !== "");
	if (!line) return undefined;
	let title = line;
	for (let previous = ""; title !== previous; ) {
		previous = title;
		title = stripOnce(title);
	}
	const cut = Array.from(title).slice(0, TITLE_MAX_CHARS).join("").trim();
	return cut === "" ? undefined : cut;
}

/**
 * The thinking level a title call runs at: `off` when the model supports it, else the model's lowest supported
 * level. A forced level needs room for its reasoning, so its `maxTokens` is larger than the direct answer's.
 */
export function titleThinking(model: Model<Api>): { level: ModelThinkingLevel; maxTokens: number } {
	const supported = getSupportedThinkingLevels(model);
	const level = supported.includes("off") ? "off" : (supported[0] ?? "off");
	return { level, maxTokens: level === "off" ? 256 : 2048 };
}

/** The text parts of a durable message, joined; user content may also be a bare string. */
function textOf(message: { readonly content?: unknown } | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap((part: unknown) => {
			const block = part as { type?: unknown; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
		})
		.join("");
}

function truncate(text: string): string {
	return Array.from(text).slice(0, TITLE_INPUT_MAX_CHARS).join("");
}

/**
 * The title call's time limit, in milliseconds. `timeoutMs` bounds each provider SDK request, and the abort
 * signal also stops a stream that stalls after the response has started. A call cut by this limit follows the
 * ordinary failure path: the generating state is cleared and the session stays pending for the next run.
 */
export const TITLE_TIMEOUT_MS = 180_000;

/**
 * Generates a title for the run that just ended, if the session still needs one. The caller must not await this
 * on the run's end path: it returns at once and generation continues in the background. `sessionId` is only a
 * hint for an overlapping trigger; every check is repeated from the database.
 */
export function maybeGenerateTitle(host: RuntimeHost, sessionId: string, submissionId: string): void {
	if (!host.sessionFlags.beginTitle(sessionId)) return;
	void generateTitle(host, sessionId, submissionId)
		.catch((err: unknown) => {
			if (!host.closing()) console.error(`title generation: session ${sessionId} failed:`, err);
		})
		.finally(() => host.sessionFlags.endTitle(sessionId));
}

async function generateTitle(host: RuntimeHost, sessionId: string, submissionId: string): Promise<void> {
	if (host.closing()) return;
	const row = await host.db
		.selectFrom("sessions")
		.select(["id", "conversation_id", "parent_session_id", "title_pending", "model"])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	// Only a user-created root starts pending; a child or a scheduled run never does.
	if (!row || row.parent_session_id !== null || row.title_pending !== 1) return;

	const over = await exhaustedLevel(host.db, sessionId);
	if (over) {
		console.error(`title generation: session ${sessionId} skipped, quota level ${over} is used up`);
		return;
	}

	const submission = await host.harness().submission(Number(submissionId) as unknown as SubmissionId, host.context);
	if (!submission) return;
	const settled = await submission.wait(host.context);
	if (settled.status !== "done" || settled.type !== "input") return;

	const conversation = await conversationOf(host, row);
	if (!conversation) return;
	const [userEntry, answerEntry] = await Promise.all([
		conversation
			.entries({ minEntryId: settled.entry, maxEntryId: settled.entry, order: "ascending" }, 1, undefined, host.context)
			.then((page) => page.items[0]),
		conversation
			.entries(
				{ minEntryId: settled.answer, maxEntryId: settled.answer, order: "ascending" },
				1,
				undefined,
				host.context,
			)
			.then((page) => page.items[0]),
	]);
	const userText = truncate(textOf(userEntry?.model?.[0] as { content?: unknown } | undefined));
	const answerText = truncate(textOf(answerEntry?.model?.[0] as { content?: unknown } | undefined));
	if (userText === "" || answerText === "") {
		console.error(`title generation: session ${sessionId} has no text to title`);
		return;
	}

	const preset = host.modelPresets.get("title");
	const ref = preset.model ?? (JSON.parse(row.model) as ModelRef);
	const resolved = host.models.getModel(ref.provider, ref.modelId);
	if (!resolved) {
		console.error(`title generation: model ${ref.provider}/${ref.modelId} is not configured`);
		return;
	}

	const systemPrompt = titleSystemPrompt(preset.systemPrompt);
	const messages = [
		{
			role: "user" as const,
			content: `User message:\n${userText}\n\nAssistant answer:\n${answerText}`,
			timestamp: Date.now(),
		},
	];
	const { level, maxTokens } = titleThinking(resolved);
	const providerSessionId = host.models.providerSessionIdFor(sessionId);
	const answer = await host.models.completeSimple(
		resolved,
		{ systemPrompt, messages },
		{
			// A custom provider's session fields resolve from the crh session, as Auto Review passes it.
			sessionId: providerSessionId ?? sessionId,
			maxTokens,
			...(level === "off" ? {} : { reasoning: level }),
			timeoutMs: TITLE_TIMEOUT_MS,
			signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
		},
	);
	await chargeCall(host.db, sessionId, callTokens(answer, estimateRequestTokens({ systemPrompt, messages })));

	const title = sanitizeTitle(answer.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""));
	if (!title) {
		console.error(`title generation: session ${sessionId} produced no usable title`);
		return;
	}

	const now = new Date().toISOString();
	// One conditional UPDATE: the `title_pending` check and the write are atomic without a transaction.
	const result = await host.db
		.updateTable("sessions")
		.set({ title, title_pending: 0, updated_at: now })
		.where("id", "=", sessionId)
		.where("title_pending", "=", 1)
		.executeTakeFirst();
	const written = result.numUpdatedRows > 0n;
	// A manual rename during the generation cleared `title_pending`; its title wins and this one is dropped.
	if (written) host.sessionList.publishSession(sessionId);
}
