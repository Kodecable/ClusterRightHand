import type { AssistantMessage, Message as PiMessage, Usage as PiUsage } from "@earendil-works/pi-ai";
import type {
	AgentEvent,
	CompactionStatus,
	ConversationId,
	EntryId,
	EntryRecord as PiEntryRecord,
	SnapshotEvent as PiSnapshotEvent,
	ToolSlot as PiToolSlot,
	SubmissionId,
	TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { toEntryRecord, toSessionEvent } from "../src/agent/session-events.ts";

/** A pi assistant message with every field an upgrade could add to the wire; only the WebUI's fields survive. */
const piUsage: PiUsage = {
	input: 3,
	output: 4,
	cacheRead: 5,
	cacheWrite: 6,
	cacheWrite1h: 7,
	reasoning: 2,
	totalTokens: 18,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

const piAssistant: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "text", text: "hi", textSignature: "text-signature" },
		{ type: "thinking", thinking: "hmm", thinkingSignature: "thinking-signature", redacted: true },
		{
			type: "toolCall",
			id: "call-1",
			name: "exec",
			arguments: { cmd: "true" },
			thoughtSignature: "sig",
			namespace: "ns",
		},
	],
	api: "faux",
	provider: "faux",
	model: "faux/model",
	responseModel: "response-model",
	responseId: "response-id",
	providerThinkingLevel: "high",
	thinkingLevel: "high",
	usage: piUsage,
	stopReason: "stop",
	errorMessage: "boom",
	rawStopReason: "end_turn",
	endTurn: true,
	timestamp: 10,
	durationMs: 5,
};

const wireUsage = {
	input: 3,
	output: 4,
	cacheRead: 5,
	cacheWrite: 6,
	totalTokens: 18,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

const wireAssistant = {
	role: "assistant" as const,
	content: [
		{ type: "text" as const, text: "hi" },
		{ type: "thinking" as const, thinking: "hmm", redacted: true },
		{ type: "toolCall" as const, id: "call-1", name: "exec", arguments: { cmd: "true" } },
	],
	usage: wireUsage,
	stopReason: "stop",
	errorMessage: "boom",
	timestamp: 10,
	durationMs: 5,
};

const piEntry: PiEntryRecord = {
	id: 42 as EntryId,
	conversationId: 7 as ConversationId,
	kind: "pi.assistant",
	model: [piAssistant],
	data: { nested: [1, { ok: true }] },
	head: 1 as EntryId,
	byTaskId: 3 as TaskId,
};

const piToolSlot: PiToolSlot = {
	callId: "call-1",
	name: "exec",
	status: "running",
	output: "line",
	droppedBytes: 10,
	droppedLines: 2,
	details: { state: "working" },
	diagnostics: [{ severity: "warn", message: "slow", code: "slow" }],
	taskId: 4 as TaskId,
	entry: 42 as EntryId,
};

const piCompaction: CompactionStatus = {
	taskId: 9 as CompactionStatus["taskId"],
	reason: "manual",
	blocking: false,
	attempt: 1,
	retry: { at: 100, error: "again" },
};

const NESTED_TOOL = {
	callId: "call-1/0",
	name: "inner",
	status: "running" as const,
	parentCallId: "call-1",
	parentTaskId: 4 as TaskId,
	taskId: 5 as TaskId,
	arguments: { a: 1 },
	output: "nested",
};

/** The snapshot event pi's watch starts with, with fields the WebUI must never see. */
function piSnapshot(): PiSnapshotEvent {
	return {
		type: "snapshot",
		entries: [piEntry],
		run: { inputs: [1 as SubmissionId] },
		generation: {
			attempt: 1,
			message: piAssistant,
			retry: { at: 2, error: "retrying" },
			deferred: { pollAt: 3 },
		},
		tools: [piToolSlot],
		nestedTools: [NESTED_TOOL],
		compactions: [piCompaction],
		compactionFailure: { taskId: 9 as CompactionStatus["taskId"], reason: "manual", error: "failed" },
		inbox: [{ id: 2 as SubmissionId, mode: "steer" }],
		agent: { model: { provider: "faux", modelId: "faux/model" } },
		usage: { models: { "faux/model": piUsage }, tools: {} },
	};
}

describe("toSessionEvent", () => {
	it("wraps a pi snapshot and copies only the wire fields", () => {
		expect(toSessionEvent(piSnapshot())).toEqual({
			type: "snapshot",
			snapshot: {
				entries: [{ id: 42, kind: "pi.assistant", model: [wireAssistant], data: { nested: [1, { ok: true }] } }],
				run: { inputs: [1] },
				generation: { attempt: 1, message: wireAssistant, retry: { at: 2, error: "retrying" } },
				tools: [
					{
						callId: "call-1",
						name: "exec",
						status: "running",
						output: "line",
						details: { state: "working" },
						entry: 42,
					},
				],
				inbox: [{ id: 2, mode: "steer" }],
				usage: { models: { "faux/model": wireUsage }, tools: {} },
				compactions: [{ taskId: 9, reason: "manual", blocking: false, attempt: 1, retry: { at: 100, error: "again" } }],
			},
		});
	});

	it("copies a message block by block, dropping provider signatures and unknown extras", () => {
		const user: PiMessage = {
			role: "user",
			content: [
				{ type: "text", text: "look", textSignature: "sig" },
				{ type: "image", data: "BASE64", mimeType: "image/png" },
			],
			timestamp: 5,
		};
		expect(toSessionEvent({ type: "message_start", message: user })).toEqual({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image" }], timestamp: 5 },
		});

		const event = toSessionEvent({ type: "message_start", message: piAssistant });
		if (event?.type !== "message_start" || event.message.role !== "assistant")
			throw new Error("not an assistant start");
		expect(event.message).toEqual(wireAssistant);
		expect(event.message.content[0]).not.toHaveProperty("textSignature");
		expect(event.message.content[1]).not.toHaveProperty("thinkingSignature");
		expect(event.message.content[2]).not.toHaveProperty("thoughtSignature");
		expect(event.message.content[2]).not.toHaveProperty("namespace");
	});

	it("copies tool events without pi's task ids or diagnostics", () => {
		const start: AgentEvent = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "exec",
			args: { cmd: "true" },
			taskId: 4 as TaskId,
			parentTaskId: 5 as TaskId,
		};
		expect(toSessionEvent(start)).toEqual({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "exec",
			args: { cmd: "true" },
		});

		const update: AgentEvent = {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "exec",
			taskId: 4 as TaskId,
			output: { trimStart: 3, append: "more" },
			details: { state: "working" },
			diagnostics: [{ severity: "error", message: "bad" }],
		};
		expect(toSessionEvent(update)).toEqual({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "exec",
			output: { trimStart: 3, append: "more" },
			details: { state: "working" },
		});
	});

	it("drops the events the WebUI ignores", () => {
		expect(toSessionEvent({ type: "agent_changed", agent: {} })).toBeNull();
		expect(toSessionEvent({ type: "deferred_poll", pollAt: 1 })).toBeNull();
		expect(
			toSessionEvent({
				type: "submission",
				record: {
					type: "input",
					status: "queued",
					id: 1 as SubmissionId,
					conversationId: 1 as ConversationId,
				},
			}),
		).toBeNull();
	});

	it("converts an entry's model messages and data explicitly", () => {
		expect(toEntryRecord(piEntry)).toEqual({
			id: 42,
			kind: "pi.assistant",
			model: [wireAssistant],
			data: { nested: [1, { ok: true }] },
		});
	});

	it("maps every remaining event type without throwing", () => {
		const events: AgentEvent[] = [
			{ type: "run_start", inputs: [1 as SubmissionId] },
			{ type: "run_end", inputs: [] },
			{ type: "turn_start" },
			{ type: "turn_end" },
			{ type: "message_end", entry: piEntry },
			{ type: "inbox_update", items: [{ id: 2 as SubmissionId, mode: "steer" }] },
			{ type: "entry_appended", entry: piEntry },
			{ type: "usage_changed", usage: { models: {}, tools: {} } },
			{ type: "auto_retry_start", attempt: 1, at: 2, errorMessage: "again" },
			{ type: "auto_retry_end", attempt: 1 },
			{ type: "task_failed", taskId: 3 as TaskId, kind: "pi.generation", message: "boom" },
			{ type: "compaction_start", taskId: 4 as TaskId, reason: "manual", blocking: true },
			{ type: "compaction_end", taskId: 4 as TaskId, reason: "manual", error: "boom" },
		];
		expect(events.map((event) => toSessionEvent(event)?.type)).toEqual(events.map((event) => event.type));
	});

	it("converts every message-change form", () => {
		expect(
			toSessionEvent({
				type: "message_update",
				usage: piUsage,
				changes: [
					{ type: "text_start", contentIndex: 0, block: { type: "text", text: "", textSignature: "sig" } },
					{ type: "text_delta", contentIndex: 0, delta: "hi" },
					{ type: "toolcall_delta", contentIndex: 1, path: ["a", 0], delta: "x" },
					{ type: "block", contentIndex: 2, block: { type: "thinking", thinking: "t", thinkingSignature: "sig" } },
					{ type: "message", message: piAssistant },
				],
			}),
		).toEqual({
			type: "message_update",
			usage: wireUsage,
			changes: [
				{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
				{ type: "text_delta", contentIndex: 0, delta: "hi" },
				{ type: "toolcall_delta", contentIndex: 1, path: ["a", 0], delta: "x" },
				{ type: "block", contentIndex: 2, block: { type: "thinking", thinking: "t" } },
				{ type: "message", message: wireAssistant },
			],
		});
	});
});
