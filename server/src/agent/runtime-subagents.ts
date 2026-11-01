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
import { NotFoundError, UserError } from "../users/service.ts";
import { derivedId } from "../util/id.ts";
import type { ModelRef } from "./models.ts";
import type { AgentRequestView, RuntimeHost } from "./runtime-core.ts";
import { conversationOf, loadConversation, loadSession } from "./runtime-core.ts";
import { nextRequests, pendingAgentRequests } from "./runtime-requests.ts";
import { refreshState } from "./runtime-state.ts";
import { recordInput } from "./runtime-submissions.ts";
import { sessionAncestors } from "./session-chain.ts";
import type { SessionState } from "./session-state.ts";

/**
 * Subagents (doc/agent-runtime.md#subagent): a tool call creates an ownerless child session with its own
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

/** Subagent sessions nest at most this deep below a root session (doc/agent-runtime.md#subagent). */
export const MAX_SUBAGENT_DEPTH = 2;

/** Keeps a conversation at the depth limit from offering the subagent tool to its model. */
async function hideSubagentTool(host: RuntimeHost, conversation: Conversation): Promise<void> {
	const tool = host.options.subagentTool;
	if (!tool) return;
	await conversation.configure({ tools: { remove: [tool] } }, host.context);
}

/**
 * Reconciles old conversations with the depth limit; new children are handled in createSubagent. Only a
 * session at the limit can be affected, so `depthLimitedSessions` walks up from the subagent rows and finds
 * exactly those, instead of loading every session's parent at startup (doc/webui.md: 100,000 sessions).
 */
export async function enforceDepthToolLimits(host: RuntimeHost): Promise<void> {
	const limited = await depthLimitedSessions().execute(host.db);
	for (const row of limited.rows) {
		const conversation = await conversationOf(host, row);
		if (!conversation) continue;
		const agent = await conversation.agent(host.context);
		if (agent.tools.some((tool) => tool.name === "subagent")) await hideSubagentTool(host, conversation);
	}
}

/** The ids of every session below this one, depth first. */
export async function descendants(host: RuntimeHost, sessionId: string): Promise<string[]> {
	const children = await host.db
		.selectFrom("sessions")
		.select("id")
		.where("parent_session_id", "=", sessionId)
		.execute();
	const out: string[] = [];
	for (const c of children) out.push(c.id, ...(await descendants(host, c.id)));
	return out;
}

/**
 * Creates (or, on a rerun of the same tool call, finds) a subagent's session: its own conversation, rule set and
 * quota, below the parent's chain (doc/agent-runtime.md#subagent). The child is ownerless so that a parent's
 * earlier return or abort does not kill it; the runtime cancels it explicitly.
 */
export async function createSubagent(
	host: RuntimeHost,
	parentId: string,
	input: { callKey: string; task: string; rules: RuleSet; quota: number | null },
): Promise<{ id: string; created: boolean }> {
	const parent = await loadSession(host, parentId);
	let depth = 0;
	for await (const _ancestor of sessionAncestors(host.db, parent.parent_session_id)) depth++;
	if (depth >= MAX_SUBAGENT_DEPTH) {
		// Also fix a session created before the tool was removed at the limit.
		const parentConversation = await conversationOf(host, parent);
		if (parentConversation) await hideSubagentTool(host, parentConversation);
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
	const model = JSON.parse(parent.model) as ModelRef;
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
			...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
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
				root_session_id: parent.root_session_id ?? parent.id,
				title: input.task.slice(0, 80),
				model: parent.model,
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
	host.subagentParents.add(parent.id);
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
		title: string;
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
	const states = new Map<string, SessionState>();
	for (const r of rows) states.set(r.id, await refreshState(host, r.id));
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
	return (await descendants(host, sessionId)).includes(childId);
}

/**
 * The sessions at the subagent depth limit, with the conversation that may still offer the subagent tool:
 * `enforceDepthToolLimits` fixes them at startup (a session created before the per-conversation filter may
 * still offer it). Walking up from the subagent rows costs one covering range scan of
 * `sessions_parent_updated_idx` for the seed, a primary-key lookup per ancestor, and one for each affected
 * session; roots and unrelated sessions are never read. A session deeper than the limit (data from an older
 * version) is reported once, at the limit, exactly like the old per-row walk.
 */
export function depthLimitedSessions() {
	return sql<{ id: string; conversation_id: string }>`
		with recursive ancestry(id, ancestor_id, depth) as (
			select id, parent_session_id, 1 from sessions where parent_session_id is not null
			union all
			select ancestry.id, parent.parent_session_id, ancestry.depth + 1
			from ancestry
			join sessions as parent on parent.id = ancestry.ancestor_id
			where ancestry.depth < ${MAX_SUBAGENT_DEPTH} and parent.parent_session_id is not null
		)
		select sessions.id, sessions.conversation_id
		from ancestry
		join sessions on sessions.id = ancestry.id
		where ancestry.depth >= ${MAX_SUBAGENT_DEPTH}
	`;
}
