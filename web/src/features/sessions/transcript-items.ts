/** The derived transcript view of a session's state: what the rows render, in display order. */

import type { Json, JsonObject, Message, TextBlock, ThinkingBlock, ToolCallBlock } from "./session-events";
import type { SessionState } from "./session-reducer";

type TranscriptItemRow =
	| { kind: "user"; key: string; text: string; at?: number }
	| {
			kind: "text";
			key: string;
			text: string;
			streaming: boolean;
			/** The row came from the live stream and keeps its `StreamingTextStore` after commit. */
			live?: boolean;
			/** Epoch ms when the producing assistant message started. */
			at?: number;
			/** How long the producing assistant message took. */
			durationMs?: number;
	  }
	| {
			kind: "thinking";
			key: string;
			text: string;
			streaming: boolean;
			/** The row came from the live stream and keeps its `StreamingTextStore` after commit. */
			live?: boolean;
	  }
	| {
			kind: "tool";
			key: string;
			callId: string;
			name: string;
			args: JsonObject;
			status: "pending" | "running" | "done";
			output: string;
			details: Json | undefined;
			/** The result's content blocks, one per block: a text result has a raw and a note block. */
			result: { text: string; isError: boolean; details: Json | undefined; blocks?: string[] } | undefined;
	  }
	| { kind: "error"; key: string; reason: "aborted" | "failed"; message: string | null }
	| { kind: "compaction"; key: string; text: string }
	| { kind: "compacting"; key: string };

/**
 * A rendered transcript row. `entryId` is the durable entry it came from, on every
 * row of a committed entry (an assistant entry contributes one row per block, all
 * with the same id). Only the live-only rows (a message that is still streaming,
 * the running compaction) have no entry yet; the session page's jump-to-message
 * scrolls to the first row sharing the target entry id.
 */
export type TranscriptItem = TranscriptItemRow & { entryId?: string };

function userText(content: string | { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content.map((c) => (c.type === "text" ? (c.text ?? "") : "[image]")).join("");
}

/** The result's text blocks in order; an old result has exactly one. */
function textBlocks(content: { type: string; text?: string }[]): string[] {
	return content.filter((c) => c.type === "text").map((c) => c.text ?? "");
}

/**
 * The numeric commit order of an entry id; `undefined` for ids that are not
 * finite numbers. A snapshot lists entries in the model's view order (a
 * compaction comes before the messages it kept), so the transcript re-sorts by
 * id to match the order the entries committed in (doc/design/webui.md "Message rendering").
 */
function entryOrder(id: string): number | undefined {
	if (id.trim() === "") return undefined;
	const value = Number(id);
	return Number.isFinite(value) ? value : undefined;
}

/** The transcript in display order: tool results are folded into their call's card. */
export function transcript(state: SessionState): TranscriptItem[] {
	// Sort a copy: entries keep their arrival order in the state, so prepending a
	// history page and reducing live events stay untouched. Non-numeric ids
	// compare equal, so a stable sort keeps their relative position.
	const ordered = [...state.entries].sort((a, b) => {
		const left = entryOrder(a.id);
		const right = entryOrder(b.id);
		return left === undefined || right === undefined ? 0 : left - right;
	});
	const results = new Map<string, Extract<Message, { role: "toolResult" }>>();
	for (const { message } of ordered) if (message.role === "toolResult") results.set(message.toolCallId, message);
	const items: TranscriptItem[] = [];
	const addAssistant = (
		entryId: string | undefined,
		key: string,
		m: Extract<Message, { role: "assistant" }>,
		streaming: boolean,
		liveRow: boolean,
	) => {
		const entry = entryId === undefined ? {} : { entryId };
		const timing = {
			...(m.timestamp === undefined ? {} : { at: m.timestamp }),
			...(m.durationMs === undefined ? {} : { durationMs: m.durationMs }),
		};
		m.content.forEach((b, i) => {
			const k = `${key}/${i}`;
			// While streaming, a block is listed from its first delta; its text is
			// read from the row's own StreamingTextStore, not from this snapshot.
			if (b.type === "text") {
				const text = (b as TextBlock).text;
				if (text || streaming)
					items.push({
						kind: "text",
						key: k,
						text,
						streaming,
						...entry,
						...(liveRow ? { live: true } : {}),
						...timing,
					});
			} else if (b.type === "thinking") {
				const text = (b as ThinkingBlock).thinking;
				if (text || streaming)
					items.push({
						kind: "thinking",
						key: k,
						text,
						streaming,
						...entry,
						...(liveRow ? { live: true } : {}),
					});
			} else if (b.type === "toolCall") {
				const call = b as ToolCallBlock;
				const live = state.tools[call.id];
				const res = results.get(call.id);
				items.push({
					kind: "tool",
					key: k,
					...entry,
					callId: call.id,
					name: call.name,
					args: call.arguments ?? {},
					status: res ? "done" : (live?.status ?? "pending"),
					output: live?.output ?? "",
					details: res?.details ?? live?.details,
					result: res
						? {
								text: userText(res.content),
								isError: res.isError,
								details: res.details,
								blocks: textBlocks(res.content),
							}
						: undefined,
				});
			}
		});
		if (!streaming && (m.stopReason === "error" || m.stopReason === "aborted")) {
			items.push({
				kind: "error",
				key: `${key}/stop`,
				...entry,
				reason: m.stopReason === "aborted" ? "aborted" : "failed",
				message: m.errorMessage ?? null,
			});
		}
	};
	for (const { id, kind, message } of ordered) {
		if (kind === "pi.compaction" && message.role === "user") {
			items.push({ kind: "compaction", key: id, entryId: id, text: userText(message.content) });
		} else if (message.role === "user")
			items.push({
				kind: "user",
				key: id,
				entryId: id,
				text: userText(message.content),
				...(message.timestamp === undefined ? {} : { at: message.timestamp }),
			});
		else if (message.role === "assistant") {
			const liveKey = state.streamedKeys[id];
			addAssistant(id, liveKey ?? id, message, false, liveKey !== undefined);
		}
	}
	if (state.streaming) addAssistant(undefined, state.liveKey ?? "streaming", state.streaming, true, true);
	// One live row per running compaction, always after everything already shown (doc/design/webui.md "Message rendering").
	for (const { taskId } of state.compactions) items.push({ kind: "compacting", key: `compacting/${taskId}` });
	return items;
}
