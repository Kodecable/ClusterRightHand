import { withAbortSignal } from "@earendil-works/chord/context";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	defineDocFamily,
	type SettledSubmissionRecord,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { sql } from "kysely";
import type { RuleSet } from "../policy/rules.ts";
import { createRuleSet } from "../policy/store.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { derivedId } from "../util/id.ts";
import { type ModelRef, thinkingLevelOf } from "./models.ts";
import type { AgentRequestView, RuntimeHost } from "./runtime-core.ts";
import { conversationOf, loadConversation, loadSession } from "./runtime-core.ts";
import { nextRequests, pendingAgentRequests } from "./runtime-requests.ts";
import { refreshStates } from "./runtime-state.ts";
import { recordInput } from "./runtime-submissions.ts";
import { MAX_SESSION_TREE_DEPTH, sessionAncestors } from "./session-chain.ts";
import type { SessionState } from "./session-state.ts";

/**
 * Subagents (doc/design/agent-runtime.md "Subagents"): a tool call creates an ownerless child session with its own
 * conversation, rule set and quota below the parent's chain, starts it, and waits for its answer — or returns
 * at once when it runs in the background, so the parent's agent acts on the child's requests instead.
 */

/**
 * Durable link from a subagent tool call (the key is its tool task id) to the ownerless conversation it created.
 * The conversation and the link are committed together, so a rerun after a crash reuses the conversation instead
 * of starting another one.
 */
const SubagentConversationLink = defineDocFamily<{ conversationId: string | null }, null>({
	kind: "crh.subagent_conversation",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ conversationId: null }),
	checkpointWhen: () => true,
});

/** Subagent sessions nest at most this deep below a root session (doc/design/agent-runtime.md "Subagents"). */
export const MAX_SUBAGENT_DEPTH = 2;

/** Keeps a conversation at the depth limit from offering the subagent tool to its model. */
async function hideSubagentTool(host: RuntimeHost, conversation: Conversation): Promise<void> {
	const tool = host.options.subagentTool;
	if (!tool) return;
	await conversation.configure({ tools: { remove: [tool] } }, host.context);
}

/**
 * Creates (or, on a rerun of the same tool call, finds) a subagent's session: its own conversation, rule set and
 * quota, below the parent's chain (doc/design/agent-runtime.md "Subagents"). The child is ownerless so that a parent's
 * earlier return or abort does not kill it; the runtime cancels it explicitly.
 */
export async function createSubagent(
	host: RuntimeHost,
	parentId: string,
	input: { callKey: string; task: string; rules: RuleSet; quota: number | null; model?: ModelRef },
): Promise<{ id: string; created: boolean }> {
	const parent = await loadSession(host, parentId);
	let depth = 0;
	for await (const _ancestor of sessionAncestors(host.db, parent.parent_session_id)) depth++;
	if (depth >= MAX_SUBAGENT_DEPTH) {
		throw new UserError(`subagents nest at most ${MAX_SUBAGENT_DEPTH} levels deep`);
	}

	const childId = derivedId(`subagent:${input.callKey}`);
	const existing = await host.db
		.selectFrom("sessions")
		.select(["id", "conversation_id"])
		.where("id", "=", childId)
		.executeTakeFirst();
	if (existing) {
		if (depth + 1 >= MAX_SUBAGENT_DEPTH) {
			const existingConversation = await conversationOf(host, existing);
			if (existingConversation) await hideSubagentTool(host, existingConversation);
		}
		return { id: childId, created: false };
	}
	// The parent may pick the child's model (like its rules and quota); without one the child inherits the
	// parent's, keeping its thinking level clamped to the child's model.
	const parentModel = JSON.parse(parent.model) as ModelRef;
	const requested = input.model ?? { provider: parentModel.provider, modelId: parentModel.modelId };
	const model = host.models.resolveRef(requested, thinkingLevelOf(parentModel));
	const parentConversation = await conversationOf(host, parent);
	if (!parentConversation) throw new NotFoundError("the parent's conversation is missing");
	// Create the ownerless conversation and the link to it in one commit; a rerun after a crash finds the link
	// instead of creating a second, orphaned conversation.
	const conversationId = await parentConversation.commit(async (tx) => {
		const link = await tx.doc(SubagentConversationLink, input.callKey, null);
		if (link.conversationId) return link.conversationId;
		const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
		link.conversationId = String(created.id);
		return String(created.id);
	}, host.context);
	const conversation = await host
		.harness()
		.conversation(Number(conversationId) as unknown as ConversationId, host.context);
	if (!conversation) throw new NotFoundError("the subagent's conversation is missing");
	await conversation.configure(
		{
			model: { provider: model.provider, modelId: model.modelId },
			thinkingLevel: thinkingLevelOf(model),
		},
		host.context,
	);
	if (depth + 1 >= MAX_SUBAGENT_DEPTH) await hideSubagentTool(host, conversation);
	const now = new Date().toISOString();
	await host.db.transaction().execute(async (trx) => {
		await trx
			.insertInto("sessions")
			.values({
				id: childId,
				org_id: parent.org_id,
				owner_user_id: parent.owner_user_id,
				conversation_id: String(conversation.id),
				parent_session_id: parent.id,
				root_session_id: parent.root_session_id,
				title: input.task.slice(0, 80),
				// A child's title is the start of its task; it never generates one.
				title_pending: 0,
				model: JSON.stringify(model),
				status: "active",
				created_at: now,
				updated_at: now,
				archived_at: null,
				quota_tokens: input.quota,
				state: "idle",
				waiting_kind: null,
				waiting_level_id: null,
				waiting_handler_id: null,
				state_changed_at: now,
			})
			.execute();
		await createRuleSet(trx, parent.org_id, { type: "session", id: childId }, input.rules);
	});
	host.sessionCaches.rememberSubagentParent(parent.id);
	void host.audit?.record({
		actor: {
			type: parent.parent_session_id ? "subagent" : "session",
			id: parent.id,
			onBehalfOfUserId: parent.owner_user_id,
		},
		action: "session.subagent_created",
		target: { type: "session", id: childId },
		detail: { rules: input.rules, quota: input.quota },
	});
	return { id: childId, created: true };
}

/** Hands the parent's task text to the child; a rerun with the same requestId does not send it twice. */
export async function startSubagent(
	host: RuntimeHost,
	childId: string,
	text: string,
	requestId: string,
): Promise<string> {
	const { row, conversation } = await loadConversation(host, childId, {
		noConversation: "the subagent's conversation is missing",
	});
	const submission = await conversation.submit({ type: "input", content: text, requestId }, host.context);
	await recordInput(host, childId, submission);
	void host.audit?.record({
		actor: { type: "subagent", id: row.parent_session_id ?? childId, onBehalfOfUserId: row.owner_user_id },
		action: "session.message",
		target: { type: "session", id: childId },
		detail: { submission_id: String(submission.id), chars: text.length },
	});
	return String(submission.id);
}

/**
 * Waits for the child's answer. With `attention`, an approval handed to this session's agent ends the wait early:
 * the parent decides with subagent_decide() and then waits again.
 */
export async function waitSubagent(
	host: RuntimeHost,
	childId: string,
	options: { attention?: boolean; signal?: AbortSignal; handler?: string } = {},
): Promise<
	| { status: "done"; answer: string }
	| { status: "unanswered"; reason: string }
	| { status: "attention"; requests: AgentRequestView[] }
> {
	const row = await loadSession(host, childId, "no such subagent session");
	const submissionId = row.last_submission_id;
	if (!submissionId) return { status: "unanswered", reason: "the subagent was never started" };
	const context = options.signal ? withAbortSignal(options.signal, host.context) : host.context;
	const submission = await host.harness().submission(Number(submissionId) as unknown as SubmissionId, context);
	if (!submission) return { status: "unanswered", reason: "the subagent's input is gone" };
	const settled = submission.wait(context);
	if (!options.attention) return answerOf(host, childId, await settled);

	const abort = new AbortController();
	const attentionRun = nextRequests(host, options.handler ?? row.parent_session_id ?? childId, abort.signal);
	void attentionRun.catch(() => {});
	const attention = attentionRun.then((requests) => ({ kind: "attention" as const, requests }));
	const first = await Promise.race([settled.then((s) => ({ kind: "settled" as const, s })), attention]);
	abort.abort();
	if (first.kind === "attention") {
		void settled.catch(() => {});
		return { status: "attention", requests: first.requests };
	}
	return answerOf(host, childId, first.s);
}

async function answerOf(
	host: RuntimeHost,
	childId: string,
	settled: SettledSubmissionRecord,
): Promise<{ status: "done"; answer: string } | { status: "unanswered"; reason: string }> {
	if (settled.status !== "done" || settled.type !== "input") {
		return {
			status: "unanswered",
			reason: settled.status === "unanswered" ? String(settled.reason) : settled.status,
		};
	}
	const { conversation } = await loadConversation(host, childId, {
		missing: "no such subagent session",
		noConversation: "the subagent's conversation is missing",
	});
	const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), host.context);
	const message = entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
	const answer = (message?.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");
	return { status: "done", answer };
}

/** The session's subagents, newest first, with what waits for this session's agent. */
export async function subagentSessions(
	host: RuntimeHost,
	sessionId: string,
): Promise<
	{
		id: string;
		title: string | null;
		state: SessionState;
		createdAt: string;
		lastSubmissionId: string | null;
		pending: AgentRequestView[];
	}[]
> {
	const rows = await host.db
		.selectFrom("sessions")
		.selectAll()
		.where("parent_session_id", "=", sessionId)
		.orderBy("created_at", "desc")
		.execute();
	// One batched recompute over all children; only a child whose stored state is stale falls back to the
	// coalesced single-session refresh that writes it (doc/design/agent-runtime.md "Session state").
	const states = await refreshStates(host, rows);
	const pending = await pendingAgentRequests(host, sessionId);
	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		state: states.get(r.id) ?? r.state,
		createdAt: r.created_at,
		lastSubmissionId: r.last_submission_id,
		pending: pending.filter((p) => p.sessionId === r.id),
	}));
}

/** True when `childId` is this session's own subagent or below one (so it may wait for or stop it). */
export async function isDescendant(host: RuntimeHost, sessionId: string, childId: string): Promise<boolean> {
	// Walk up from the child, not down through the whole subtree: the check costs the chain's length, not its size.
	const result = await sql<{ id: string }>`
		with recursive ancestors(id, depth) as (
			select parent_session_id, 1 from sessions where id = ${childId} and parent_session_id is not null
			union all
			select parent.parent_session_id, ancestors.depth + 1
			from ancestors
			join sessions as parent on parent.id = ancestors.id
			where ancestors.depth < ${MAX_SESSION_TREE_DEPTH} and parent.parent_session_id is not null
		)
		select id from ancestors where id = ${sessionId} limit 1
	`.execute(host.db);
	return result.rows.length > 0;
}
