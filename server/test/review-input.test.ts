import type { EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { apiRouteSummary, reviewGroupOperation, reviewInput, reviewTaskOperation } from "../src/agent/review.ts";
import {
	type ReviewHistoryEntry,
	reviewHistoryEntries,
	reviewTimeline,
	TOOL_CALL_ARG_BYTES,
	TOOL_CALL_BYTES,
	USER_TURNS,
} from "../src/agent/review-history.ts";
import type { TaskGroupView } from "../src/cluster/task-groups.ts";
import type { TaskView } from "../src/cluster/types.ts";
import { configureBuiltinExtensions } from "../src/extensions/builtin.ts";

/** Auto Review's input window and roles (doc/design/access-control.md "Auto Review"). */

const user = (text: string): ReviewHistoryEntry => ({ kind: "user", text, attachments: [] });
const tool = (name: string, data: string): ReviewHistoryEntry => ({ kind: "tool", tool: name, arguments: { data } });
const checkpoint = (summary: string): ReviewHistoryEntry => ({ kind: "checkpoint", summary });

function keptUsers(items: ReturnType<typeof reviewTimeline>): string[] {
	return items.flatMap((item) => (item.kind === "user-instruction" ? [item.text] : []));
}

function keptTools(items: ReturnType<typeof reviewTimeline>): string[] {
	return items.flatMap((item) => (item.kind === "tool-call" ? [item.tool] : []));
}

describe("reviewTimeline", () => {
	it("keeps the last 20 user instructions and all their tool calls", () => {
		const entries: ReviewHistoryEntry[] = [];
		for (let turn = 0; turn < USER_TURNS + 5; turn++) {
			entries.push(user(`u${turn}`));
			entries.push(tool(`t${turn}`, "x"));
		}
		const timeline = reviewTimeline(entries);
		expect(timeline[0]).toEqual({ kind: "omitted", marker: "[earlier history omitted]" });
		expect(keptUsers(timeline)).toEqual(Array.from({ length: USER_TURNS }, (_, index) => `u${index + 5}`));
		expect(keptTools(timeline)).toEqual(Array.from({ length: USER_TURNS }, (_, index) => `t${index + 5}`));
	});

	it("keeps the newest tool calls within the byte budget and marks the gap in place", () => {
		const entries: ReviewHistoryEntry[] = [user("u0")];
		for (let index = 0; index < 10; index++) entries.push(tool(`t${index}`, "x".repeat(4_000)));
		entries.push(user("u1"));
		const timeline = reviewTimeline(entries);
		// Eight calls fit: each costs its name plus ~4011 serialized argument bytes (under the cut limit).
		expect(keptTools(timeline)).toEqual(["t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
		expect(timeline[1]).toEqual({ kind: "omitted", marker: "[2 earlier tool calls omitted here]" });
		expect(keptUsers(timeline)).toEqual(["u0", "u1"]);
		const bytes = keptTools(timeline).reduce((sum, name) => {
			const entry = entries.find((candidate) => candidate.kind === "tool" && candidate.tool === name);
			return sum + (entry?.kind === "tool" ? Buffer.byteLength(JSON.stringify(entry.arguments)) + name.length : 0);
		}, 0);
		expect(bytes).toBeLessThanOrEqual(TOOL_CALL_BYTES);
	});

	it("keeps order and drops every tool call older than the oldest kept instruction", () => {
		const entries: ReviewHistoryEntry[] = [];
		for (let turn = 0; turn < USER_TURNS + 5; turn++) {
			entries.push(user(`u${turn}`));
			entries.push(tool(`t${turn}a`, "y".repeat(2_000)));
			entries.push(tool(`t${turn}b`, "y".repeat(2_000)));
		}
		const timeline = reviewTimeline(entries);
		const oldestKept = timeline.find((item) => item.kind === "user-instruction");
		expect(oldestKept).toMatchObject({ text: "u5" });
		const tools = keptTools(timeline);
		expect(tools.length).toBeGreaterThan(0);
		// Tool names were chosen by turn, so the oldest kept one belongs to turn 5 or later.
		for (const name of tools) {
			const turn = Number(/^t(\d+)[ab]$/.exec(name)?.[1]);
			expect(turn).toBeGreaterThanOrEqual(5);
		}
		// Kept items stay in the original order.
		const turnOf = (name: string) => Number(/^t(\d+)[ab]$/.exec(name)?.[1]);
		expect(tools.map(turnOf)).toEqual([...tools.map(turnOf)].sort((left, right) => left - right));
		expect(timeline[0]).toEqual({ kind: "omitted", marker: "[earlier history omitted]" });
	});

	it("drops tool calls older than the oldest kept instruction even with budget left", () => {
		const entries: ReviewHistoryEntry[] = [tool("t-old", "x"), user("u0"), tool("t-new", "x")];
		const timeline = reviewTimeline(entries);
		expect(keptUsers(timeline)).toEqual(["u0"]);
		expect(keptTools(timeline)).toEqual(["t-new"]);
		expect(timeline[0]).toEqual({ kind: "omitted", marker: "[earlier history omitted]" });
	});

	it("cuts an oversized argument, notes the original size and counts the cut bytes", () => {
		const entries: ReviewHistoryEntry[] = [user("u0")];
		for (let index = 0; index < 6; index++) entries.push(tool(`t${index}`, "z".repeat(8_000)));
		const timeline = reviewTimeline(entries);
		const tools = timeline.filter((item) => item.kind === "tool-call");
		// If the original ~8012 bytes counted, only four would fit; six cut-to-4-KiB calls do.
		expect(tools).toHaveLength(6);
		for (const item of tools) {
			if (item.kind !== "tool-call") continue;
			expect(typeof item.arguments).toBe("string");
			expect(Buffer.byteLength(item.arguments as string, "utf8")).toBeLessThanOrEqual(TOOL_CALL_ARG_BYTES);
			expect(item.note).toContain(String(Buffer.byteLength(JSON.stringify({ data: "z".repeat(8_000) }), "utf8")));
		}
	});

	it("keeps only the latest checkpoint, at its position", () => {
		const before: ReviewHistoryEntry[] = [checkpoint("c0")];
		for (let turn = 0; turn < USER_TURNS + 5; turn++) before.push(user(`u${turn}`));
		const first = reviewTimeline(before);
		expect(first[0]).toEqual({ kind: "checkpoint", summary: "c0" });
		expect(keptUsers(first)[0]).toBe("u5");

		const both: ReviewHistoryEntry[] = [
			user("u0"),
			user("u1"),
			checkpoint("c0"),
			user("u2"),
			user("u3"),
			user("u4"),
			checkpoint("c1"),
			user("u5"),
		];
		const second = reviewTimeline(both);
		expect(second.filter((item) => item.kind === "checkpoint")).toEqual([{ kind: "checkpoint", summary: "c1" }]);
		expect(
			second.map((item) =>
				item.kind === "checkpoint" ? item.summary : item.kind === "user-instruction" ? item.text : "?",
			),
		).toEqual(["u0", "u1", "u2", "u3", "u4", "c1", "u5"]);
	});
});

describe("reviewHistoryEntries", () => {
	it("keeps user instructions, tool calls and the checkpoint, never assistant text or tool results", () => {
		const summary =
			"The conversation history before this point was compacted into the following summary:\n\n<summary>\ngoal: ship\n</summary>";
		const entries = [
			{
				id: 1,
				conversationId: 1,
				kind: "pi.user",
				// The sent time crhs appends is not part of the user's instruction.
				model: [
					{
						role: "user",
						content: [
							{ type: "text", text: "deploy it" },
							{ type: "text", text: "[Sent 2026-11-19 19:30, Thursday, UTC (UTC+00:00), the server's time zone]" },
						],
					},
				],
			},
			{
				id: 2,
				conversationId: 1,
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "ASSISTANT-SECRET" },
							{ type: "thinking", thinking: "THINKING-SECRET" },
							{ type: "toolCall", id: "call-1", name: "exec", arguments: { command: "rm -rf /data" } },
							// Still waiting (no result): the call under review, not an earlier fact.
							{ type: "toolCall", id: "call-2", name: "exec", arguments: { command: "PENDING-CALL" } },
						],
					},
				],
			},
			{
				id: 3,
				conversationId: 1,
				kind: "pi.tool-result",
				model: [
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "exec",
						content: [{ type: "text", text: "TOOL-RESULT-SECRET" }],
					},
				],
			},
			{ id: 4, conversationId: 1, kind: "pi.system", model: [{ role: "system", content: "" }] },
			{
				id: 5,
				conversationId: 1,
				kind: "pi.compaction",
				model: [{ role: "user", content: [{ type: "text", text: summary }] }],
			},
		] as unknown as EntryRecord[];
		const history = reviewHistoryEntries(entries);
		expect(history).toEqual([
			{ kind: "user", text: "deploy it", attachments: [] },
			{ kind: "tool", tool: "exec", arguments: { command: "rm -rf /data" } },
			{ kind: "checkpoint", summary: "goal: ship" },
		]);
		expect(JSON.stringify(history)).not.toContain("SECRET");
		expect(JSON.stringify(history)).not.toContain("PENDING-CALL");
	});

	it("carries attachment metadata and no content", () => {
		const entries = [
			{
				id: 1,
				conversationId: 1,
				kind: "crh.user_input",
				model: [{ role: "user", content: [{ type: "text", text: "see this" }] }],
				data: {
					attachments: [
						{ library: "lib", path: "a.png", name: "a.png", bytes: 42, mime: "image/png", sha256: "x", inlined: false },
					],
				},
			},
		] as unknown as EntryRecord[];
		expect(reviewHistoryEntries(entries)).toEqual([
			{ kind: "user", text: "see this", attachments: [{ name: "a.png", type: "image/png", size: 42 }] },
		]);
	});
});

describe("apiRouteSummary", () => {
	afterEach(() => configureBuiltinExtensions());

	it("matches the trusted API route summary", () => {
		configureBuiltinExtensions({
			api: {
				document: { paths: { "/api/nodes": { get: { summary: "List the nodes", "x-crh-agent": "allow" } } } },
				request: async () => new Response("{}"),
			},
		});
		expect(apiRouteSummary("crhs-api", "api_request", { method: "get", path: "/api/nodes" })).toBe("List the nodes");
		expect(apiRouteSummary("crhs-api", "api_request", { method: "get", path: "/api/missing" })).toBeNull();
		expect(apiRouteSummary("other", "api_request", { method: "get", path: "/api/nodes" })).toBeNull();
	});
});

const web = { id: "node-1", name: "web-1", groups: ["staging"] };

function taskView(overrides: Partial<TaskView> = {}): TaskView {
	return {
		id: "task-1",
		nodeId: "node-1",
		kind: "file.write",
		summary: "file.write /etc/app.conf",
		operation: { method: "file.write", target: "/etc/app.conf" },
		actorType: "session",
		actorId: "session-1",
		onBehalfOfUserId: "user-1",
		state: "awaiting_approval",
		approval: { evaluation: { result: "require-approval", levels: [] } },
		...overrides,
	} as TaskView;
}

/** The operation block of a review input, as the reviewer parses it. */
function operationOf(input: string): Record<string, unknown> {
	const blocks = [...input.matchAll(/```json\n([\s\S]*?)\n```/g)];
	const block = blocks.at(-1)?.[1];
	if (block === undefined) throw new Error("the review input has no operation block");
	return JSON.parse(block) as Record<string, unknown>;
}

describe("review operation block", () => {
	it("carries the original tool call, its description and the trusted context", () => {
		const arguments_ = {
			targets: ["web-1"],
			path: "/etc/app.conf",
			content: "listen 80;\n",
			overwrite: false,
		};
		const input = reviewInput(
			[],
			reviewTaskOperation(
				taskView(),
				{ id: "call-1", name: "write_file", arguments: arguments_ },
				"Create a file on one node. Fails if the file exists unless overwrite is true.",
				[web],
			),
		);
		const operation = operationOf(input);
		expect(operation.tool_call).toEqual({ name: "write_file", arguments: arguments_ });
		expect(operation.tool_description).toContain("Fails if the file exists unless overwrite is true");
		expect(operation.trusted_context).toEqual({
			nodes: [web],
			flagged: [{ node: "node-1", method: "file.write", target: "/etc/app.conf" }],
		});
		expect(operation.note).toBeUndefined();
	});

	it("passes oversized arguments complete", () => {
		const content = "MARKER-AT-THE-END".repeat(8_000);
		const arguments_ = { content, overwrite: false };
		const block = reviewTaskOperation(taskView(), { id: "call-1", name: "write_file", arguments: arguments_ }, null, [
			web,
		]);
		const call = block.tool_call as { arguments: unknown; arguments_note?: string };
		expect(call.arguments).toBe(arguments_);
		expect(call.arguments_note).toBeUndefined();
		expect(JSON.stringify(block)).toContain("MARKER-AT-THE-END");
	});

	it("names every flagged member of a task group, not only the first", () => {
		const group = {
			id: "group-1",
			kind: "exec",
			summary: "exec true",
			operation: { method: "exec", target: "true" },
			actorType: "session",
			actorId: "session-1",
			nodeIds: ["node-1", "node-2"],
			approval: {
				nodes: [
					{ nodeId: "node-1", evaluation: { result: "require-approval", levels: [] } },
					{ nodeId: "node-2", evaluation: { result: "allow", levels: [] } },
				],
			},
		} as unknown as TaskGroupView;
		const block = reviewGroupOperation(group, { id: "call-1", name: "exec", arguments: { command: "true" } }, null, [
			web,
			{ id: "node-2", name: "web-2", groups: [] },
		]);
		expect(block.trusted_context).toEqual({
			nodes: [web, { id: "node-2", name: "web-2", groups: [] }],
			flagged: [{ node: "node-1", method: "exec", target: "true" }],
		});
	});
});
