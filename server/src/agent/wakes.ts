import { awaitingQuotaSessions } from "./quota.ts";
import { conversationOf, type RuntimeHost } from "./runtime-core.ts";
import { pendingAgentRequests, requestKey, wakeRequestKey } from "./runtime-requests.ts";
import { recordInput } from "./runtime-submissions.ts";
import { parentOf, type SessionRow } from "./session-chain.ts";

/**
 * Waking the agent that has to act on a subagent request (doc/agent-runtime.md#处理子会话的请求): a follow-up
 * input to an idle handler at once, or one held until a running handler goes idle. One path for every request
 * kind, so a request can never wake its handler twice, and a request settled in the meantime is dropped.
 */

/** Wakes an idle parent with a follow-up input; a running parent sees the request through afterTool. */
export async function wakeParent(
	host: RuntimeHost,
	parent: Pick<SessionRow, "id">,
	kind: "task" | "task_group",
	requestId: string,
): Promise<void> {
	await wake(
		host,
		parent.id,
		`agent-request:${kind}:${requestId}`,
		`A subagent request is waiting for you: ${kind} ${requestId}. ` +
			`Check it with subagent_list, then call subagent_decide("${requestId}", "approve" | "deny" | "escalate", reason?).`,
	);
}

/** Wakes a handler about a paused subagent's quota wait; `since` keeps one pause's wake stable across restarts. */
export async function wakeQuota(
	host: RuntimeHost,
	handlerId: string,
	sessionId: string,
	levelId: string,
	since: string,
): Promise<void> {
	// `since` keeps one pause's wake stable across polls and restarts, and makes the next pause a new request.
	await wake(
		host,
		handlerId,
		`quota-request:${sessionId}:${levelId}:${since}`,
		`A subagent is paused: its token quota is used up (session ${sessionId}, level ${levelId}). ` +
			`Check it with subagent_list, then subagent_decide("${sessionId}", "approve", tokens: <positive integer>) ` +
			'to add quota, or "deny" to stop it.',
	);
}

/** One wake path for every subagent request: a follow-up input to an idle handler, or one queued until idle. */
async function wake(host: RuntimeHost, handlerId: string, requestId: string, content: string): Promise<void> {
	const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
	if (!row) return;
	const conversation = await conversationOf(host, row);
	if (!conversation) return;
	const state = await conversation.viewState(host.context);
	const live = state.value.docs["pi.live"] as { run?: unknown } | undefined;
	state.dispose();
	if (live?.run) {
		// The handler is running; afterTool shows the request. If it ends without handling it, flush the wake.
		queueWake(host, handlerId, requestId, content);
		watchIdle(host, handlerId);
		return;
	}
	dropWake(host, handlerId, requestId);
	await submitWake(host, handlerId, requestId, content);
}

async function submitWake(host: RuntimeHost, handlerId: string, requestId: string, content: string): Promise<void> {
	const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
	if (!row) return;
	const conversation = await conversationOf(host, row);
	if (!conversation) return;
	const submission = await conversation.submit({ type: "input", content, requestId }, host.context);
	await recordInput(host, handlerId, submission);
}

function queueWake(host: RuntimeHost, handlerId: string, requestId: string, content: string): void {
	const wakes = host.pendingWakes.get(handlerId) ?? new Map<string, string>();
	wakes.set(requestId, content);
	host.pendingWakes.set(handlerId, wakes);
}

export function dropWake(host: RuntimeHost, handlerId: string, requestId: string): void {
	const wakes = host.pendingWakes.get(handlerId);
	if (!wakes) return;
	wakes.delete(requestId);
	if (wakes.size === 0) host.pendingWakes.delete(handlerId);
}

export function dropWakePrefix(host: RuntimeHost, handlerId: string, prefix: string): void {
	const wakes = host.pendingWakes.get(handlerId);
	if (!wakes) return;
	for (const requestId of wakes.keys()) if (requestId.startsWith(prefix)) wakes.delete(requestId);
	if (wakes.size === 0) host.pendingWakes.delete(handlerId);
}

/** Watches a running handler once; `waitForIdle` resolves when its own run ends, not by polling. */
function watchIdle(host: RuntimeHost, handlerId: string): void {
	if (host.idleWatchers.has(handlerId)) return;
	host.idleWatchers.add(handlerId);
	void (async () => {
		try {
			const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
			if (!row) return;
			const conversation = await conversationOf(host, row);
			if (!conversation) return;
			await conversation.waitForIdle(host.context);
		} finally {
			host.idleWatchers.delete(handlerId);
		}
		await flushWakes(host, handlerId);
	})().catch((err: unknown) => {
		host.idleWatchers.delete(handlerId);
		console.error("agent runtime: flushing a subagent wake failed:", err);
	});
}

async function flushWakes(host: RuntimeHost, handlerId: string): Promise<void> {
	const wakes = host.pendingWakes.get(handlerId);
	if (!wakes?.size) return;
	const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
	if (!row) {
		host.pendingWakes.delete(handlerId);
		return;
	}
	const conversation = await conversationOf(host, row);
	if (!conversation) {
		host.pendingWakes.delete(handlerId);
		return;
	}
	const state = await conversation.viewState(host.context);
	const live = state.value.docs["pi.live"] as { run?: unknown } | undefined;
	state.dispose();
	if (live?.run) {
		// A new run started between idle and the flush; wait for that one too.
		watchIdle(host, handlerId);
		return;
	}
	// A rule change, token revoke or a decision may have settled the request after it was queued.
	const pending = new Set((await pendingAgentRequests(host, handlerId)).map(requestKey));
	host.pendingWakes.delete(handlerId);
	for (const [requestId, content] of wakes) {
		const key = wakeRequestKey(requestId);
		if (key && !pending.has(key)) continue;
		try {
			await submitWake(host, handlerId, requestId, content);
		} catch (err) {
			console.error("agent runtime: waking a subagent handler failed:", err);
		}
	}
}

/** After a restart, wakes the parents of requests that were already waiting (deduplicated by requestId). */
export async function wakePendingAgents(host: RuntimeHost): Promise<void> {
	const requests: { kind: "task" | "task_group"; id: string; session: string }[] = [];
	const tasks = await host.db
		.selectFrom("tasks")
		.select(["id", "handler_session_id"])
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "agent")
		.execute();
	for (const row of tasks) {
		if (row.handler_session_id) requests.push({ kind: "task", id: row.id, session: row.handler_session_id });
	}
	const groups = await host.db
		.selectFrom("task_groups")
		.select(["id", "handler_session_id"])
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "agent")
		.execute();
	for (const row of groups) {
		if (row.handler_session_id) requests.push({ kind: "task_group", id: row.id, session: row.handler_session_id });
	}
	for (const request of requests) {
		const parent = await host.db
			.selectFrom("sessions")
			.selectAll()
			.where("id", "=", request.session)
			.executeTakeFirst();
		if (!parent) continue;
		try {
			await wakeParent(host, parent, request.kind, request.id);
		} catch (err) {
			console.error("agent runtime: waking for a subagent request failed:", err);
		}
	}
	for (const wait of await awaitingQuotaSessions(host.db)) {
		// A root-level wait has no handler: the owner sees it in the approvals API.
		const parent = wait.handlerId || (await parentOf(host.db, wait.levelId));
		if (!parent) continue;
		try {
			await wakeQuota(host, parent, wait.sessionId, wait.levelId, wait.since);
		} catch (err) {
			console.error("agent runtime: waking for a quota wait failed:", err);
		}
	}
}
