import type { EntryRecord } from "@crh/api";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentState, ConversationId, Storage } from "@earendil-works/pi-durable";
import type { AgentRuntime } from "../../src/agent/runtime.ts";
import type { Db } from "../../src/storage/db.ts";
import { TOOLS } from "../../src/tools/catalog.ts";

/**
 * Test-side reads that AgentRuntime answers only for tests (the code-only-tests review item): waiting for a
 * submission's answer, and the tools a session's model is offered. Both are derived from the durable store,
 * so the tests keep asserting exactly what they did before.
 */

/** The tools the crh extension adds to the cluster tools (see clusterExtension in agent/extension.ts). */
const EXTENSION_TOOLS = ["subagent", "subagent_wait", "subagent_list", "subagent_cancel", "subagent_decide"];

/**
 * Waits for the submission and returns the answer's text. The run's answer is its last assistant entry: the
 * generation task appends it before it settles the submission (doc/design/agent-runtime.md).
 */
export async function waitSubmission(
	runtime: AgentRuntime,
	sessionId: string,
	submissionId: string,
	signal?: AbortSignal,
): Promise<{ status: "done"; answer: string } | { status: "unanswered"; reason: string }> {
	const settled = await runtime.waitForSubmission(submissionId, signal);
	if (settled.status !== "done") return { status: "unanswered", reason: settled.reason };
	const { entries } = await runtime.entriesPage(sessionId, undefined, 100);
	const answer = [...entries].reverse().find((entry) => entry.kind === "pi.assistant");
	return { status: "done", answer: answerText(answer) };
}

function answerText(entry: EntryRecord | undefined): string {
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content
		.flatMap((block) => (block.type === "text" && "text" in block && block.text ? [block.text] : []))
		.join("");
}

/**
 * The tool names a session's model is offered: the cluster tools and the extension's subagent tools, minus
 * those the conversation's durable agent document filters out (a subagent at the depth limit loses `subagent`).
 */
export async function toolNames(storage: Storage, db: Db, sessionId: string): Promise<string[]> {
	const row = await db.selectFrom("sessions").select("conversation_id").where("id", "=", sessionId).executeTakeFirst();
	if (!row) throw new Error("no such session");
	const conversationId = Number(row.conversation_id) as unknown as ConversationId;
	const record = await storage.findDocument(
		{ kind: "pi.agent", scope: { kind: "conversation", conversationId } },
		"current",
		BACKGROUND_CONTEXT,
	);
	const doc = record ? await storage.document(record.id, "current", BACKGROUND_CONTEXT) : undefined;
	const filter = ((doc?.value ?? {}) as AgentState).tools;
	const names = [...TOOLS.map((tool) => tool.name), ...EXTENSION_TOOLS];
	if (filter === undefined) return names;
	if (Array.isArray(filter)) return names.filter((name) => filter.includes(name));
	const removed = filter.remove ?? [];
	return names.filter((name) => !removed.includes(name));
}
