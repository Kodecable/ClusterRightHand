import { type ApprovalRecord, summarize } from "../cluster/cluster.ts";
import type { TaskGroupApprovalRecord } from "../cluster/task-groups.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { awaitingQuotaChildren, grantQuota } from "./quota.ts";
import type { AgentRequestView, RuntimeHost } from "./runtime-core.ts";
import type { Inbox } from "./runtime-host/inboxes.ts";
import { refreshState } from "./runtime-state.ts";
import { parentOf, sessionAncestors } from "./session-chain.ts";
import { markSessionsIdle } from "./session-state.ts";
import { wakeParent } from "./wakes.ts";

/**
 * Requests waiting for one session's agent (doc/agent-runtime.md#处理子会话的请求): a cache over the durable
 * task, task-group and quota waits, invalidated whenever an approval changes. `waitSubagent` waits on it
 * instead of polling, and a routed request wakes the handler through the wake module.
 */

export function requestKey(request: AgentRequestView): string {
	return `${request.kind}:${request.id}`;
}

/** Request key behind a wake request id, for checking that the request is still pending before flushing. */
export function wakeRequestKey(requestId: string): string | undefined {
	if (requestId.startsWith("agent-request:task:")) return `task:${requestId.slice("agent-request:task:".length)}`;
	if (requestId.startsWith("agent-request:task_group:"))
		return `task_group:${requestId.slice("agent-request:task_group:".length)}`;
	if (requestId.startsWith("quota-request:")) {
		const rest = requestId.slice("quota-request:".length);
		const end = rest.indexOf(":");
		if (end > 0) return `quota:${rest.slice(0, end)}`;
	}
	return undefined;
}

/** Requests waiting for this session's agent (doc/access-control.md#审批). */
export async function pendingAgentRequests(host: RuntimeHost, sessionId: string): Promise<AgentRequestView[]> {
	const inbox = await ensureInbox(host, sessionId);
	return [...inbox.requests.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function inboxOf(host: RuntimeHost, handlerId: string): Inbox {
	return host.inboxes.inbox(handlerId);
}

async function ensureInbox(host: RuntimeHost, handlerId: string): Promise<Inbox> {
	for (;;) {
		const inbox = inboxOf(host, handlerId);
		if (inbox.loaded) return inbox;
		const requests = await queryRequests(host, handlerId);
		// An approval change during the read deleted the entry; load the replacement instead of caching stale data.
		if (host.inboxes.current(handlerId) !== inbox) continue;
		host.inboxes.load(inbox, new Map(requests.map((request) => [requestKey(request), request])));
		return inbox;
	}
}

async function queryRequests(host: RuntimeHost, handlerId: string): Promise<AgentRequestView[]> {
	const out: AgentRequestView[] = [];
	const tasks = await host.db
		.selectFrom("tasks")
		.select(["id", "actor_id", "node_id", "spec", "created_at"])
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "agent")
		.where("handler_session_id", "=", handlerId)
		.execute();
	for (const row of tasks) {
		out.push({
			kind: "task",
			id: row.id,
			sessionId: row.actor_id,
			summary: summarize(row.spec),
			nodeId: row.node_id,
			createdAt: row.created_at,
		});
	}
	const groups = await host.db
		.selectFrom("task_groups")
		.select(["id", "actor_id", "spec", "created_at"])
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "agent")
		.where("handler_session_id", "=", handlerId)
		.execute();
	for (const row of groups) {
		out.push({
			kind: "task_group",
			id: row.id,
			sessionId: row.actor_id,
			summary: row.spec ? summarize(row.spec) : "",
			nodeId: null,
			createdAt: row.created_at,
		});
	}
	for (const wait of await awaitingQuotaChildren(host.db, handlerId)) {
		out.push({
			kind: "quota",
			id: wait.sessionId,
			sessionId: wait.sessionId,
			summary: `${wait.levelTitle ?? "the session"} is at ${wait.levelQuota ?? "unlimited"} tokens; the subagent is paused`,
			nodeId: null,
			createdAt: wait.since,
		});
	}
	return out;
}

/** Resolves with the handler's next pending requests; no polling (the inbox notifies it). */
export async function nextRequests(
	host: RuntimeHost,
	handlerId: string,
	signal: AbortSignal,
): Promise<AgentRequestView[]> {
	for (;;) {
		if (signal.aborted) throw new Error("aborted");
		const inbox = inboxOf(host, handlerId);
		let resolve!: () => void;
		const changed = new Promise<void>((r) => {
			resolve = r;
			host.inboxes.addWaiter(inbox, r);
		});
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<"aborted">((r) => {
			onAbort = () => r("aborted");
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const requests = await pendingAgentRequests(host, handlerId);
			if (requests.length > 0) return requests;
			const outcome = await Promise.race([changed.then(() => "changed" as const), aborted]);
			if (outcome === "aborted") throw new Error("aborted");
		} finally {
			host.inboxes.removeWaiter(inbox, resolve);
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}
}

/** The agent of `sessionId` settles a request it owns: approve, deny, or pass it on to the user. */
export async function decideAgentRequest(
	host: RuntimeHost,
	sessionId: string,
	requestId: string,
	decision: "approve" | "deny" | "escalate",
	reason?: string,
	tokens?: number,
): Promise<"task" | "task_group" | "quota"> {
	const session = await host.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
	if (!session) throw new NotFoundError("no such session");
	const by = {
		type: session.parent_session_id ? "subagent" : "session",
		id: sessionId,
		onBehalfOfUserId: session.owner_user_id,
	};
	const task = await host.db
		.selectFrom("tasks")
		.select(["id", "state", "approval", "on_behalf_of_user_id", "actor_id"])
		.where("id", "=", requestId)
		.executeTakeFirst();
	if (task) {
		const approval = JSON.parse(task.approval ?? "{}") as ApprovalRecord;
		if (approval.agent?.session !== sessionId || approval.agent.state !== "pending") {
			throw new UserError("this request is not waiting for this session's agent");
		}
		if (decision === "escalate") {
			if (!(await host.cluster.escalateAgentDecision(requestId, sessionId)))
				throw new UserError("the request is no longer waiting");
		} else {
			const at = new Date().toISOString();
			const ok = await host.cluster.decide(
				requestId,
				{
					decision: decision === "approve" ? "approved" : "rejected",
					by: { ...by, onBehalfOfUserId: task.on_behalf_of_user_id },
					at,
					...(reason ? { reason } : {}),
				},
				{ handlerType: "agent", handlerSessionId: sessionId },
			);
			if (!ok) throw new UserError("the request is no longer waiting");
		}
		host.wakes.drop(sessionId, `agent-request:task:${requestId}`);
		await refreshState(host, task.actor_id);
		return "task";
	}
	const waiting = await host.db.selectFrom("sessions").selectAll().where("id", "=", requestId).executeTakeFirst();
	if (waiting?.state === "awaiting" && waiting.waiting_kind === "quota" && waiting.waiting_level_id) {
		const levelId = waiting.waiting_level_id;
		if ((await parentOf(host.db, levelId)) !== sessionId) {
			throw new UserError("this quota wait is not handled by this session's agent");
		}
		if (decision === "escalate") {
			throw new UserError("a quota wait goes to the direct parent only; approve or deny it");
		}
		if (decision === "deny") {
			// A call paused right now is told by the in-memory mark, so it ends instead of waiting again.
			if (host.quotaWaits.hasWaiters(requestId)) host.quotaWaits.markDenied(requestId);
			await markSessionsIdle(host.db, [requestId]);
		} else {
			if (tokens === undefined) throw new UserError("give the quota wait tokens to grant");
			// No cap: the whole chain is charged for every response, so the parent's own remainder does
			// not limit what it can add for its child (D77).
			await grantQuota(host.db, levelId, tokens);
		}
		void host.audit?.record({
			actor: by,
			action: decision === "deny" ? "quota.denied" : "quota.granted",
			target: { type: "session", id: requestId },
			detail: { level: levelId, ...(reason ? { reason } : {}), ...(tokens ? { tokens } : {}) },
		});
		host.wakes.dropPrefix(sessionId, `quota-request:${requestId}:`);
		host.quotaWaits.wakeAll();
		host.inboxes.clear();
		// A denial already left the session idle; a grant lets the paused call resume and write `running` itself.
		if (decision === "deny") await refreshState(host, requestId);
		return "quota";
	}
	const group = await host.db
		.selectFrom("task_groups")
		.select(["id", "state", "approval", "on_behalf_of_user_id", "actor_id"])
		.where("id", "=", requestId)
		.executeTakeFirst();
	if (!group) throw new NotFoundError("no such request");
	const approval = JSON.parse(group.approval ?? "{}") as TaskGroupApprovalRecord;
	if (approval.agent?.session !== sessionId || approval.agent.state !== "pending") {
		throw new UserError("this request is not waiting for this session's agent");
	}
	if (decision === "escalate") {
		if (!(await host.taskGroups.escalateAgentDecision(requestId, sessionId)))
			throw new UserError("the request is no longer waiting");
	} else {
		const ok = await host.taskGroups.decide(
			requestId,
			{
				decision: decision === "approve" ? "approved" : "rejected",
				by: { ...by, onBehalfOfUserId: group.on_behalf_of_user_id },
				at: new Date().toISOString(),
				...(reason ? { reason } : {}),
			},
			{ handlerType: "agent", handlerSessionId: sessionId },
		);
		if (!ok) throw new UserError("the request is no longer waiting");
	}
	host.wakes.drop(sessionId, `agent-request:task_group:${requestId}`);
	await refreshState(host, group.actor_id);
	return "task_group";
}

/**
 * Routes a waiting approval up the chain (doc/agent-runtime.md#处理子会话的请求): the first ancestor whose effective
 * result is allow decides through its agent, the root session included (D100); without one, the owner decides.
 */
export async function routeAwaiting(
	host: RuntimeHost,
	kind: "task" | "task_group",
	actorId: string,
	requestId: string,
	approval: ApprovalRecord | TaskGroupApprovalRecord | null,
): Promise<void> {
	if (!approval) return;
	const evaluations = "evaluation" in approval ? [approval.evaluation] : approval.nodes.map((n) => n.evaluation);
	if (evaluations.length === 0) return;
	const actor = await host.db.selectFrom("sessions").selectAll().where("id", "=", actorId).executeTakeFirst();
	// A request raised by the root session itself has no ancestor, so its owner decides.
	if (!actor?.parent_session_id) return;
	// Walk up from the immediate parent; an ancestor that does not allow is skipped, and the root is an
	// ordinary level of the same walk.
	for await (const parent of sessionAncestors(host.db, actor.parent_session_id)) {
		const allows = evaluations.every((evaluation) => {
			const level = evaluation.levels.find((l) => l.scope.type === "session" && l.scope.id === parent.id);
			return level?.effective === "allow";
		});
		if (allows) {
			const routed =
				kind === "task"
					? await host.cluster.requestAgentDecision(requestId, parent.id)
					: await host.taskGroups.requestAgentDecision(requestId, parent.id);
			if (routed) await wakeParent(host, parent, kind, requestId);
			return;
		}
	}
}
