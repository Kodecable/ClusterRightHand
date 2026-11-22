import type { TaskOutcome } from "@crh/api";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type AgentState,
	AssistantEntry,
	type Conversation,
	type ConversationId,
	defineDocFamily,
	type SettledSubmissionRecord,
	type SubmissionId,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { sql } from "kysely";
import { extensionNamesForUser, parseDisabledExtensionNames } from "../extensions/store.ts";
import type { SubagentJobRun } from "../jobs/types.ts";
import type { RuleSet } from "../policy/rules.ts";
import { createRuleSet } from "../policy/store.ts";
import { MAX_SESSION_TREE_DEPTH, sessionAncestors } from "../sessions/session-chain.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { derivedId } from "../util/id.ts";
import { subagentRequestsBlock, syncSessionExtensions } from "./extension.ts";
import { type ModelRef, thinkingLevelOf } from "./models.ts";
import type { AgentRequestView, RuntimeHost } from "./runtime-core.ts";
import { conversationOf, loadConversation, loadSession } from "./runtime-core.ts";
import { nextRequests, pendingAgentRequests } from "./runtime-requests.ts";
import { refreshStates } from "./runtime-state.ts";
import { recordInput } from "./runtime-submissions.ts";
import { serverTimeZone, withSentTime } from "./sent-time.ts";
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

/**
 * Keeps a conversation at the depth limit from offering the subagent tool, and a subagent from offering the
 * root-session-only tools (doc/design/todo.md "Scope"). The conversation's stored filter is merged, not replaced:
 * the depth limit and the root-only rule both remove from it, and a configure of one must not undo the other.
 */
async function hideTools(
	host: RuntimeHost,
	conversation: Conversation,
	tools: readonly ToolRegistration[],
): Promise<void> {
	if (tools.length === 0) return;
	const state = await host.harness().documentState(AgentDoc, conversation.id, host.context);
	const stored = state?.value?.tools;
	state?.dispose();
	// `configure` takes tool objects, not names: resolve them from the conversation's selected extensions,
	// including tools an earlier filter already removed from the model's list, and from the tools this call hides.
	const agent = await conversation.agent(host.context);
	const byName = new Map<string, ToolRegistration>();
	for (const extension of agent.extensions) {
		for (const tool of extension.tools ?? []) byName.set(tool.name, tool as unknown as ToolRegistration);
	}
	for (const tool of tools) byName.set(tool.name, tool);
	const plan = filterAfterHiding(
		stored,
		tools.map((tool) => tool.name),
		(name) => byName.get(name),
	);
	if (plan.kind === "unchanged") return;
	if (plan.kind === "unresolved") {
		// Writing the filter without a name it could not resolve would offer a tool the conversation meant to hide.
		console.warn(
			`agent runtime: keeping the tool filter of conversation ${String(conversation.id)} unchanged: ` +
				`${plan.names.join(", ")} ${plan.names.length === 1 ? "does" : "do"} not resolve in its selected extensions`,
		);
		return;
	}
	await conversation.configure({ tools: plan.tools }, host.context);
}

/** What `hideTools` writes to a conversation's tool filter. */
export type ToolFilterPlan =
	| {
			readonly kind: "configure";
			readonly tools: readonly ToolRegistration[] | { readonly remove: readonly ToolRegistration[] };
	  }
	| { readonly kind: "unchanged" }
	| { readonly kind: "unresolved"; readonly names: readonly string[] };

/**
 * The stored `tools` filter after it hides `names`: an allowlist keeps its order minus the hidden names, and a remove
 * list gains the names it did not have yet. A stored name `resolve` cannot turn back into a tool leaves the filter
 * unchanged — configuring the shorter list would offer a tool the conversation meant to hide — and names it in the
 * result, so the caller can log it. Exported for its own tests.
 */
export function filterAfterHiding(
	stored: AgentState["tools"],
	names: readonly string[],
	resolve: (name: string) => ToolRegistration | undefined,
): ToolFilterPlan {
	const hidden = new Set(names);
	if (Array.isArray(stored)) {
		const kept = stored.filter((name) => !hidden.has(name));
		if (kept.length === stored.length) return { kind: "unchanged" };
		const tools: ToolRegistration[] = [];
		const missing: string[] = [];
		for (const name of kept) {
			const tool = resolve(name);
			if (tool === undefined) missing.push(name);
			else tools.push(tool);
		}
		if (missing.length > 0) return { kind: "unresolved", names: missing };
		return { kind: "configure", tools };
	}
	const remove = [...new Set([...(stored?.remove ?? []), ...names])];
	if (remove.length === (stored?.remove.length ?? 0)) return { kind: "unchanged" };
	const tools: ToolRegistration[] = [];
	const missing: string[] = [];
	for (const name of remove) {
		const tool = resolve(name);
		if (tool === undefined) missing.push(name);
		else tools.push(tool);
	}
	if (missing.length > 0) return { kind: "unresolved", names: missing };
	return { kind: "configure", tools: { remove: tools } };
}

async function hideSubagentTool(host: RuntimeHost, conversation: Conversation): Promise<void> {
	const tool = host.options.subagentTool;
	if (!tool) return;
	await hideTools(host, conversation, [tool]);
}

/** Applied when a child is created and before every child run, so a child created before this tool existed loses it too. */
async function hideRootSessionTools(host: RuntimeHost, conversation: Conversation): Promise<void> {
	await hideTools(host, conversation, host.options.rootSessionTools ?? []);
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
		const existingConversation = await conversationOf(host, existing);
		if (existingConversation) {
			if (depth + 1 >= MAX_SUBAGENT_DEPTH) await hideSubagentTool(host, existingConversation);
			await hideRootSessionTools(host, existingConversation);
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
	// A subagent inherits its parent's extension set and can only turn more off (doc/design/extensions.md "Extensions").
	const disabledExtensions = parseDisabledExtensionNames(parent.disabled_extensions);
	const extensionNames = await extensionNamesForUser(host.db, parent.owner_user_id, disabledExtensions);
	await conversation.configure(
		{
			model: { provider: model.provider, modelId: model.modelId },
			thinkingLevel: thinkingLevelOf(model),
			extensions: host.extensionsFor(extensionNames),
		},
		host.context,
	);
	if (depth + 1 >= MAX_SUBAGENT_DEPTH) await hideSubagentTool(host, conversation);
	await hideRootSessionTools(host, conversation);
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
				disabled_extensions: disabledExtensions.length === 0 ? null : JSON.stringify(disabledExtensions),
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
	await hideRootSessionTools(host, conversation);
	// The subagent's next request selects its extensions from the rows read now.
	await syncSessionExtensions(host, row);
	// The parent's task carries the sent time in the server's time zone (doc/design/agent-runtime.md "Message time").
	const content = withSentTime(text, new Date(), { zone: serverTimeZone(), source: "server" });
	const submission = await conversation.submit({ type: "input", content, requestId }, host.context);
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

/** What the subagent job adapter needs from a child's run, derived from its stored session and durable input. */
export async function subagentJobState(host: RuntimeHost, childId: string): Promise<SubagentJobRun | undefined> {
	const row = await host.db
		.selectFrom("sessions")
		.select(["state", "waiting_kind", "last_submission_id", "waiting_handler_id"])
		.where("id", "=", childId)
		.executeTakeFirst();
	if (!row) return undefined;
	if (row.state === "running") return { state: "running", wait: null, outcome: null };
	if (row.state === "awaiting") {
		return { state: "awaiting", wait: await subagentWaitOf(host, childId, row.waiting_kind), outcome: null };
	}
	const submissionId = row.last_submission_id;
	if (!submissionId) return { state: "idle", wait: null, outcome: { kind: "cancelled", failed: false } };
	const submission = await host.harness().submission(Number(submissionId) as unknown as SubmissionId, host.context);
	if (!submission) return { state: "idle", wait: null, outcome: { kind: "cancelled", failed: false } };
	const status = await submission.status(host.context);
	// A row marked idle whose input is still queued is a crash between input and state write: it is running.
	if (status.status === "queued" || status.status === "placed") return { state: "running", wait: null, outcome: null };
	return { state: "idle", wait: null, outcome: subagentOutcome(status) };
}

/** What an awaiting child waits for: a decision outranks a user approval, and the stored kinds map directly. */
async function subagentWaitOf(
	host: RuntimeHost,
	childId: string,
	waitingKind: "quota" | "approval" | "authorization" | null,
): Promise<"approval" | "signature" | "quota" | "decision"> {
	if (waitingKind === "quota") return "quota";
	if (waitingKind === "authorization") return "signature";
	for (const table of ["tasks", "task_groups", "external_calls"] as const) {
		const routed = await host.db
			.selectFrom(table)
			.select("id")
			.where("actor_id", "=", childId)
			.where("state", "=", "awaiting_approval")
			.where("handler_type", "=", "agent")
			.limit(1)
			.executeTakeFirst();
		if (routed) return "decision";
	}
	return "approval";
}

/** A settled run's outcome: an aborted run was cancelled, a model or reset failure is an error. */
function subagentOutcome(settled: SettledSubmissionRecord): TaskOutcome {
	if (settled.status === "done") return { kind: "succeeded", failed: false };
	if (settled.reason === "aborted") return { kind: "cancelled", failed: false };
	return { kind: "error", failed: true, errorCode: settled.reason, errorMessage: null };
}

/** The answer of a child whose run ended, for `job_wait`; undefined while it runs or when it gave none. */
export async function subagentJobAnswer(host: RuntimeHost, childId: string): Promise<string | undefined> {
	const row = await host.db
		.selectFrom("sessions")
		.select("last_submission_id")
		.where("id", "=", childId)
		.executeTakeFirst();
	if (!row?.last_submission_id) return undefined;
	const submission = await host
		.harness()
		.submission(Number(row.last_submission_id) as unknown as SubmissionId, host.context);
	if (!submission) return undefined;
	const status = await submission.status(host.context);
	if (status.status !== "done") return undefined;
	const answer = await answerOf(host, childId, status);
	return answer.status === "done" ? answer.answer : undefined;
}

/**
 * The requests this child handed to an ancestor's agent, in the block a wait with attention returned, for `job_wait`
 * on a waiting subagent job. Requests live on their own records; the handler columns name the agent.
 */
export async function subagentJobRequestsBlock(host: RuntimeHost, childId: string): Promise<string | undefined> {
	const handlers = new Set<string>();
	for (const table of ["tasks", "task_groups", "external_calls"] as const) {
		const rows = await host.db
			.selectFrom(table)
			.select("handler_session_id")
			.where("actor_id", "=", childId)
			.where("state", "=", "awaiting_approval")
			.where("handler_type", "=", "agent")
			.execute();
		for (const row of rows) if (row.handler_session_id) handlers.add(row.handler_session_id);
	}
	const session = await host.db
		.selectFrom("sessions")
		.select(["waiting_kind", "waiting_handler_id"])
		.where("id", "=", childId)
		.executeTakeFirst();
	if (session?.waiting_kind === "quota" && session.waiting_handler_id) handlers.add(session.waiting_handler_id);
	const requests: AgentRequestView[] = [];
	for (const handler of handlers) {
		for (const request of await pendingAgentRequests(host, handler)) {
			if (request.sessionId === childId) requests.push(request);
		}
	}
	if (requests.length === 0) return undefined;
	requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return subagentRequestsBlock(requests);
}
