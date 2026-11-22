/** The derived transcript view of a session's state: what the rows render, in display order. */

import type { ChatAttachment, JobNotice } from "@crh/api";
import type { Json, JsonObject, Message, TextBlock, ThinkingBlock, ToolCallBlock } from "./session-events";
import type { SessionState } from "./session-reducer";

/**
 * The display model of one `crh.notice` entry (doc/design/jobs.md "Completion notices"): a finished job's
 * metadata, or a request wake. The model-facing text is never rendered; every surface reads this.
 */
export type NoticeItem =
	| { type: "jobs"; jobs: JobNotice[] }
	| { type: "agent_request" }
	| { type: "quota_request" }
	| { type: "other" };

type TranscriptItemRow =
	| { kind: "user"; key: string; text: string; attachments?: ChatAttachment[]; at?: number }
	| { kind: "notice"; key: string; notice: NoticeItem }
	| {
			kind: "text";
			key: string;
			text: string;
			streaming: boolean;
			/**
			 * The producing assistant message ended without tool calls, so this text can be the turn's final
			 * answer (doc/design/webui.md "Message view").
			 */
			final: boolean;
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

/** The attachments of a `crh.user_input` entry, or none for a plain `pi.user` one. */
function attachmentsOf(data: Json | undefined): ChatAttachment[] {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
	const value = data.attachments;
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
		const record = item as Record<string, unknown>;
		if (
			typeof record.library !== "string" ||
			typeof record.path !== "string" ||
			typeof record.name !== "string" ||
			typeof record.bytes !== "number" ||
			typeof record.mime !== "string" ||
			typeof record.sha256 !== "string" ||
			typeof record.inlined !== "boolean"
		) {
			return [];
		}
		return [
			{
				library: record.library,
				...(typeof record.libraryId === "string" ? { libraryId: record.libraryId } : {}),
				path: record.path,
				name: record.name,
				bytes: record.bytes,
				mime: record.mime,
				sha256: record.sha256,
				inlined: record.inlined,
			},
		];
	});
}

/** The first text block of a user message: the typed text, before attachment notes and the sent time. */
function firstText(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.find((block) => block.type === "text")?.text ?? "";
}

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
 * The display model of a `crh.notice` entry. `data` is the entry's application payload, not model text, so a
 * malformed or newer payload renders as the generic "woken" line instead of vanishing or leaking as a user
 * message.
 */
function noticeItemOf(data: Json | undefined): NoticeItem {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return { type: "other" };
	const record = data as Record<string, Json>;
	if (record.type === "agent_request") return { type: "agent_request" };
	if (record.type === "quota_request") return { type: "quota_request" };
	if (record.type !== "jobs") return { type: "other" };
	const jobs = Array.isArray(record.jobs) ? record.jobs : [];
	return {
		type: "jobs",
		jobs: jobs.flatMap((job) => {
			const parsed = noticeJobOf(job);
			return parsed === undefined ? [] : [parsed];
		}),
	};
}

/** One job of a jobs notice, checked only enough that rendering cannot throw on an unexpected payload. */
function noticeJobOf(value: Json): JobNotice | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, Json>;
	if (typeof record.jobId !== "string" || typeof record.woke !== "boolean") return undefined;
	if (record.kind !== "exec" && record.kind !== "call" && record.kind !== "subagent") return undefined;
	const action = record.action;
	if (typeof action !== "object" || action === null || Array.isArray(action)) return undefined;
	if (typeof (action as Record<string, Json>).type !== "string") return undefined;
	const outcome = record.outcome;
	if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) return undefined;
	if (typeof (outcome as Record<string, Json>).kind !== "string") return undefined;
	const resource = record.resource;
	let parsedResource: JobNotice["resource"];
	if (typeof resource === "object" && resource !== null && !Array.isArray(resource)) {
		const where = resource as Record<string, Json>;
		if (
			(where.type === "task" ||
				where.type === "task_group" ||
				where.type === "external_call" ||
				where.type === "session") &&
			typeof where.id === "string"
		) {
			parsedResource = { type: where.type, id: where.id };
		}
	}
	return {
		jobId: record.jobId,
		kind: record.kind,
		action: action as unknown as JobNotice["action"],
		outcome: outcome as unknown as JobNotice["outcome"],
		woke: record.woke,
		...(parsedResource === undefined ? {} : { resource: parsedResource }),
	};
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
		// An intermediate assistant message streams its text before the tool call arrives; only a message
		// that ended without tool calls can be a final answer.
		const endedWithoutToolCalls =
			!streaming && !m.content.some((b) => b.type === "toolCall") && m.stopReason !== "toolUse";
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
						final: endedWithoutToolCalls,
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
	for (const { id, kind, message, data } of ordered) {
		if (kind === "pi.compaction" && message.role === "user") {
			items.push({ kind: "compaction", key: id, entryId: id, text: userText(message.content) });
		} else if (kind === "crh.notice") {
			// A completion notice or a request wake is one display line, never a user message
			// (doc/design/jobs.md "Completion notices").
			items.push({ kind: "notice", key: id, entryId: id, notice: noticeItemOf(data) });
		} else if (message.role === "user") {
			const attachments = kind === "crh.user_input" ? attachmentsOf(data) : [];
			items.push({
				kind: "user",
				key: id,
				entryId: id,
				// A user input's content is the typed text first, then one block per attachment and the sent
				// time the model reads (doc/design/agent-runtime.md "Message time"); only the typed text shows.
				text: firstText(message.content),
				...(attachments.length > 0 ? { attachments } : {}),
				...(message.timestamp === undefined ? {} : { at: message.timestamp }),
			});
		} else if (message.role === "assistant") {
			const liveKey = state.streamedKeys[id];
			addAssistant(id, liveKey ?? id, message, false, liveKey !== undefined);
		}
	}
	if (state.streaming) addAssistant(undefined, state.liveKey ?? "streaming", state.streaming, true, true);
	// One live row per running compaction, always after everything already shown (doc/design/webui.md "Message rendering").
	for (const { taskId } of state.compactions) items.push({ kind: "compacting", key: `compacting/${taskId}` });
	return items;
}
