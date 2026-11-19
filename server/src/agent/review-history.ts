import type { EntryRecord } from "@earendil-works/pi-durable";
import { cutUtf8 } from "../util/utf8.ts";

/**
 * The history Auto Review shows the model (doc/design/access-control.md "Auto Review"): user instructions,
 * the latest compaction checkpoint and earlier tool calls, as data. Assistant text and thinking, tool results,
 * node output and system messages are never included. The window is applied here, as a pure function, so the
 * truncation can be tested without a runtime.
 */

/** User instructions kept: the most recent ones. */
export const USER_TURNS = 20;
/** Serialized tool calls kept: the most recent ones. */
export const TOOL_CALL_BYTES = 32 * 1024;
/** One tool call's arguments are cut to this size. */
export const TOOL_CALL_ARG_BYTES = 4 * 1024;

/** Attachment metadata; the content itself never reaches the reviewer. */
export interface ReviewAttachment {
	name: string;
	type: string;
	size: number;
}

/** One ordered history entry, before the window is applied. */
export type ReviewHistoryEntry =
	| { kind: "user"; text: string; attachments: ReviewAttachment[] }
	| { kind: "checkpoint"; summary: string }
	| { kind: "tool"; tool: string; arguments: unknown };

/** One item of the reviewer's timeline. Omission marks are items so they keep their place. */
export type ReviewTimelineItem =
	| { kind: "user-instruction"; text: string; attachments: ReviewAttachment[] }
	| { kind: "checkpoint"; summary: string }
	| { kind: "tool-call"; tool: string; arguments: unknown; note?: string }
	| { kind: "omitted"; marker: string };

/** The bytes a tool call costs the budget: its name and its serialized arguments, as they are kept. */
function toolCallBytes(tool: string, argumentsJson: string): number {
	return Buffer.byteLength(tool, "utf8") + Buffer.byteLength(argumentsJson, "utf8");
}

interface PreparedToolCall {
	item: Extract<ReviewTimelineItem, { kind: "tool-call" }>;
	bytes: number;
}

/** A tool call as the timeline shows it, cutting an oversized argument list and counting the kept bytes. */
function prepareToolCall(entry: Extract<ReviewHistoryEntry, { kind: "tool" }>): PreparedToolCall {
	const argumentsJson = JSON.stringify(entry.arguments) ?? "null";
	const originalBytes = Buffer.byteLength(argumentsJson, "utf8");
	if (originalBytes <= TOOL_CALL_ARG_BYTES) {
		return {
			item: { kind: "tool-call", tool: entry.tool, arguments: entry.arguments },
			bytes: toolCallBytes(entry.tool, argumentsJson),
		};
	}
	const kept = cutUtf8(argumentsJson, TOOL_CALL_ARG_BYTES);
	return {
		item: {
			kind: "tool-call",
			tool: entry.tool,
			arguments: kept,
			note: `arguments cut from ${originalBytes} bytes`,
		},
		bytes: toolCallBytes(entry.tool, kept),
	};
}

/**
 * Applies the review window: the most recent USER_TURNS user instructions, the most recent tool calls within
 * TOOL_CALL_BYTES (older than the oldest kept instruction are dropped), and the latest checkpoint. Kept items
 * are merged back into one timeline in their original order, with omission marks where entries were dropped.
 */
export function reviewTimeline(entries: readonly ReviewHistoryEntry[]): ReviewTimelineItem[] {
	if (entries.length === 0) return [];

	// User instructions: a suffix of the ordered turns. The oldest kept one bounds the tool-call window.
	const userIndexes: number[] = [];
	for (const [index, entry] of entries.entries()) if (entry.kind === "user") userIndexes.push(index);
	// No user instruction at all (not a session Auto Review runs for) leaves the tool window unbounded.
	const firstKeptUser = userIndexes.length === 0 ? 0 : (userIndexes[Math.max(0, userIndexes.length - USER_TURNS)] ?? 0);

	// Tool calls: newest first, within the budget and not older than the oldest kept instruction.
	const toolItems = new Map<number, Extract<ReviewTimelineItem, { kind: "tool-call" }>>();
	let budget = TOOL_CALL_BYTES;
	for (let index = entries.length - 1; index >= firstKeptUser; index--) {
		const entry = entries[index];
		if (entry?.kind !== "tool") continue;
		const prepared = prepareToolCall(entry);
		if (prepared.bytes > budget) break;
		toolItems.set(index, prepared.item);
		budget -= prepared.bytes;
	}

	// The checkpoint restores context from before the window: keep the latest one wherever it sits.
	let latestCheckpoint = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.kind === "checkpoint") {
			latestCheckpoint = index;
			break;
		}
	}

	const isKept = (index: number): boolean => {
		const entry = entries[index];
		if (entry === undefined) return false;
		if (entry.kind === "user") return index >= firstKeptUser;
		if (entry.kind === "tool") return toolItems.has(index);
		return index === latestCheckpoint;
	};

	const firstKept = entries.findIndex((_, index) => isKept(index));
	if (firstKept === -1) return [];

	const timeline: ReviewTimelineItem[] = [];
	if (firstKept > 0) timeline.push({ kind: "omitted", marker: "[earlier history omitted]" });

	// Dropped tool calls are marked where they stood, between two kept entries. Runs before the first kept
	// entry are covered by the leading mark instead.
	let keptSeen = false;
	for (const [index, entry] of entries.entries()) {
		if (isKept(index)) {
			keptSeen = true;
			if (entry.kind === "user") {
				timeline.push({ kind: "user-instruction", text: entry.text, attachments: entry.attachments });
			} else if (entry.kind === "checkpoint") {
				timeline.push({ kind: "checkpoint", summary: entry.summary });
			} else {
				const item = toolItems.get(index);
				if (item) timeline.push(item);
			}
			continue;
		}
		if (entry.kind !== "tool" || !keptSeen) continue;
		const previous = timeline[timeline.length - 1];
		if (previous?.kind === "omitted" && previous.marker.endsWith("tool calls omitted here]")) {
			const count = Number(previous.marker.slice(1, previous.marker.indexOf(" "))) + 1;
			previous.marker = `[${count} earlier tool calls omitted here]`;
		} else {
			timeline.push({ kind: "omitted", marker: "[1 earlier tool calls omitted here]" });
		}
	}
	return timeline;
}

/** A JSON block whose fence is longer than any backtick run in the payload, so the payload cannot close it. */
export function jsonBlock(value: unknown): string {
	const details = JSON.stringify(value, null, 2) ?? "null";
	const longestRun = Math.max(0, ...(details.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return `${fence}json\n${details}\n${fence}`;
}

/** The timeline as the reviewer sees it: each entry fenced as data, omission marks as plain lines. */
export function renderReviewHistory(timeline: readonly ReviewTimelineItem[]): string {
	const parts: string[] = [];
	for (const item of timeline) {
		if (item.kind === "omitted") {
			parts.push(item.marker);
		} else if (item.kind === "user-instruction") {
			parts.push(jsonBlock({ role: "user-instruction", text: item.text, attachments: item.attachments }));
		} else if (item.kind === "checkpoint") {
			parts.push(jsonBlock({ role: "checkpoint", summary: item.summary }));
		} else {
			parts.push(
				jsonBlock({
					role: "tool-call",
					tool: item.tool,
					arguments: item.arguments,
					...(item.note === undefined ? {} : { note: item.note }),
				}),
			);
		}
	}
	return parts.join("\n\n");
}

/** The compaction summary's wrapper, from pi-durable's `placeSummary`. */
const SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

/** The text blocks of a durable message. */
function textBlocks(message: { readonly content?: unknown }): string[] {
	if (typeof message.content === "string") return [message.content];
	if (!Array.isArray(message.content)) return [];
	return message.content.flatMap((block: unknown) => {
		const typed = block as { type?: unknown; text?: unknown };
		return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
	});
}

/** A user message's typed text: the first text block, not an attachment's note. */
function userInstruction(message: { readonly content?: unknown }): string {
	return textBlocks(message)[0] ?? "";
}

/** Attachment metadata stored on a `crh.user_input` entry; anything malformed is skipped. */
function attachmentsOf(data: unknown): ReviewAttachment[] {
	const value = (data as { attachments?: unknown } | undefined)?.attachments;
	if (!Array.isArray(value)) return [];
	const attachments: ReviewAttachment[] = [];
	for (const entry of value) {
		const attachment = entry as { name?: unknown; mime?: unknown; bytes?: unknown };
		if (
			typeof attachment.name !== "string" ||
			typeof attachment.mime !== "string" ||
			typeof attachment.bytes !== "number"
		) {
			continue;
		}
		attachments.push({ name: attachment.name, type: attachment.mime, size: attachment.bytes });
	}
	return attachments;
}

/** The compaction summary without its wrapper text. */
function checkpointSummary(text: string): string {
	if (text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX)) {
		return text.slice(SUMMARY_PREFIX.length, text.length - SUMMARY_SUFFIX.length);
	}
	return text;
}

/**
 * The ordered review entries of a conversation's entries. Assistant text, thinking and tool results are
 * dropped here; a `pi.assistant` entry contributes only its finished tool calls as facts.
 */
export function reviewHistoryEntries(entries: readonly EntryRecord[]): ReviewHistoryEntry[] {
	// Only calls that already have a result are earlier facts: the call under review, and any other call of its
	// round still waiting, has not run yet.
	const finished = new Set<string>();
	for (const entry of entries) {
		const message = entry.model?.[0] as { role?: unknown; toolCallId?: unknown } | undefined;
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") finished.add(message.toolCallId);
	}
	const history: ReviewHistoryEntry[] = [];
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (message !== undefined && (entry.kind === "pi.user" || entry.kind === "crh.user_input")) {
			if (message.role !== "user") continue;
			const text = userInstruction(message);
			const attachments = attachmentsOf(entry.data);
			if (text.trim() === "" && attachments.length === 0) continue;
			history.push({ kind: "user", text, attachments });
			continue;
		}
		if (entry.kind === "pi.compaction" && message !== undefined) {
			const text = textBlocks(message).join("");
			if (text.trim() !== "") history.push({ kind: "checkpoint", summary: checkpointSummary(text) });
			continue;
		}
		if (entry.kind === "pi.assistant" && message !== undefined) {
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
				if (call.type !== "toolCall" || typeof call.name !== "string") continue;
				if (typeof call.id !== "string" || !finished.has(call.id)) continue;
				history.push({ kind: "tool", tool: call.name, arguments: call.arguments });
			}
		}
	}
	return history;
}

/** One tool call as the transcript records it: the id the model requested it with, its name and its exact arguments. */
export interface ReviewToolCallRecord {
	id: string;
	name: string;
	arguments: unknown;
}
