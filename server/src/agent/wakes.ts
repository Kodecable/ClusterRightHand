import { createHash } from "node:crypto";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { InputSubmissionDraft } from "@earendil-works/pi-durable";
import { jobNoticeOf, jobNoticesText } from "../jobs/notices.ts";
import type { JobRow } from "../jobs/types.ts";
import { parentOf, type SessionRow } from "../sessions/session-chain.ts";
import { DEFAULT_MAX_CONSECUTIVE_WAKES } from "../settings/settings.ts";
import { syncSessionExtensions } from "./extension.ts";
import { awaitingQuotaSessions } from "./quota.ts";
import { conversationOf, type RuntimeHost } from "./runtime-core.ts";
import type { NoticeData } from "./runtime-host/handler-wakes.ts";
import { pendingAgentRequests, requestKey, wakeRequestKey } from "./runtime-requests.ts";
import { recordInput } from "./runtime-submissions.ts";

/**
 * Waking a session with a `crh.notice` input (doc/design/agent-runtime.md "Handling subagent requests" and
 * doc/design/jobs.md "Completion notices"): a follow-up input to an idle session at once, or one held until a
 * running session goes idle. One path for subagent requests, quota waits and job completion notices, so nothing
 * wakes twice, a request settled in the meantime is dropped, and every wake is an entry whose kind and data the
 * display surfaces read instead of the model-facing text.
 */

/** The queued-wake id of a session's completion notices; repeated settles replace one held wake. */
const JOB_NOTICE_QUEUE_KEY = "job-notice:";

/** Whether a completion-notice wake for the session is queued or being delivered. */
export function jobNoticeBusy(host: RuntimeHost, sessionId: string): boolean {
	return host.noticeActivity.active(sessionId) || host.wakes.hasPrefix(sessionId, JOB_NOTICE_QUEUE_KEY);
}

/** Wakes an idle parent with a follow-up input; a running parent sees the request through afterTool. */
export async function wakeParent(
	host: RuntimeHost,
	parent: Pick<SessionRow, "id">,
	kind: "task" | "task_group" | "external_call",
	requestId: string,
): Promise<void> {
	const what = kind === "task_group" ? "task group" : kind === "external_call" ? "external MCP call" : "task";
	await wake(
		host,
		parent.id,
		`agent-request:${kind}:${requestId}`,
		`A subagent request is waiting for you: ${what} ${requestId}. ` +
			`Check it with subagent_list, then call subagent_decide("${requestId}", "approve" | "deny" | "escalate", reason?).`,
		{ type: "agent_request", kind, requestId },
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
		{ type: "quota_request", sessionId, levelId },
	);
}

/** One wake path for every request: a follow-up input to an idle handler, or one queued until idle. */
async function wake(
	host: RuntimeHost,
	handlerId: string,
	requestId: string,
	content: string,
	data: NoticeData,
): Promise<void> {
	const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
	if (!row) return;
	const conversation = await conversationOf(host, row);
	if (!conversation) return;
	const state = await conversation.viewState(host.context);
	const live = state.value.docs["pi.live"] as { run?: unknown } | undefined;
	state.dispose();
	if (live?.run) {
		// The handler is running; afterTool shows the request. If it ends without handling it, flush the wake.
		host.wakes.queue(handlerId, requestId, { content, data });
		watchIdle(host, handlerId);
		return;
	}
	host.wakes.drop(handlerId, requestId);
	await submitNotice(host, handlerId, requestId, content, data);
}

/** Places one `crh.notice` input and records it as the session's input. */
async function submitNotice(
	host: RuntimeHost,
	handlerId: string,
	requestId: string,
	content: string,
	data: NoticeData,
): Promise<void> {
	const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
	if (!row) return;
	const conversation = await conversationOf(host, row);
	if (!conversation) return;
	// The wake starts the handler's next request, so its MCP server selection is recomputed first.
	await syncSessionExtensions(host, row);
	// The entry kind is outside `pi.`, so durable places the input as this application entry while its model
	// message stays the input's user message (doc/design/jobs.md "Completion notices").
	const draft = {
		type: "input" as const,
		content,
		requestId,
		entry: { kind: "crh.notice", data },
		...(data.type === "jobs" ? { whenBusy: "followUp" as const } : {}),
	} as unknown as InputSubmissionDraft;
	const submission = await conversation.submit(draft, host.context);
	await recordInput(host, handlerId, submission);
}

/** Watches a running handler once; `waitForIdle` resolves when its own run ends, not by polling. */
function watchIdle(host: RuntimeHost, handlerId: string): void {
	if (host.wakes.isWatching(handlerId)) return;
	host.wakes.watch(handlerId);
	void (async () => {
		try {
			const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
			if (!row) return;
			const conversation = await conversationOf(host, row);
			if (!conversation) return;
			await conversation.waitForIdle(host.context);
		} finally {
			host.wakes.unwatch(handlerId);
		}
		await flushWakes(host, handlerId);
	})().catch((err: unknown) => {
		host.wakes.unwatch(handlerId);
		console.error("agent runtime: flushing a subagent wake failed:", err);
	});
}

async function flushWakes(host: RuntimeHost, handlerId: string): Promise<void> {
	if (host.closing()) return;
	const wakes = host.wakes.pending(handlerId);
	if (!wakes?.size) return;
	const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
	if (!row) {
		host.wakes.dropAll(handlerId);
		return;
	}
	const conversation = await conversationOf(host, row);
	if (!conversation) {
		host.wakes.dropAll(handlerId);
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
	host.wakes.dropAll(handlerId);
	for (const [requestId, wake] of wakes) {
		if (requestId.startsWith(JOB_NOTICE_QUEUE_KEY)) {
			// The notices are re-read now, so settles that happened while the session ran form one input.
			try {
				await deliverJobNotices(host, handlerId);
			} catch (err) {
				console.error("agent runtime: delivering the queued job notices failed:", err);
			}
			continue;
		}
		const key = wakeRequestKey(requestId);
		if (key && !pending.has(key)) continue;
		try {
			await submitNotice(host, handlerId, requestId, wake.content, wake.data);
		} catch (err) {
			console.error("agent runtime: waking a subagent handler failed:", err);
		}
	}
	// A queued notice that was collected meanwhile is gone: project the `subagent` jobs watching this child
	// again, so their parents can settle now instead of waiting for a change that already happened.
	host.jobs?.sessionChanged(handlerId);
}

/**
 * Delivers a session's pending completion notices (doc/design/jobs.md "Completion notices"): wakes an idle owner
 * with one `crh.notice` input listing every pending job, or holds a wake for a running owner whose next tool
 * result carries them. A notice is marked `delivered` only once placed. Past `jobs.max_consecutive_wakes` wakes
 * since the last user-authored input, nothing is woken: the notices stay pending for the next tool result or the
 * next user turn.
 */
export async function deliverJobNotices(host: RuntimeHost, sessionId: string): Promise<void> {
	return host.noticeDelivery.run(sessionId, () => deliverJobNoticesLocked(host, sessionId));
}

/** The delivery itself, run one at a time per session: the read, the wake and the mark are one step. */
async function deliverJobNoticesLocked(host: RuntimeHost, sessionId: string): Promise<void> {
	const jobs = host.jobs;
	if (!jobs || host.closing()) return;
	// A stop or a deletion in flight must not be woken by a settle it is cancelling (doc/design/jobs.md "Lifecycle").
	if (host.sessionFlags.isStopping(sessionId)) return;
	host.noticeActivity.begin(sessionId);
	try {
		const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
		if (!row) return;
		const pending = await jobs.pendingNotices(sessionId);
		if (pending.length === 0) return;
		const conversation = await conversationOf(host, row);
		if (!conversation) return;
		const state = await conversation.viewState(host.context);
		const live = state.value.docs["pi.live"] as { run?: unknown } | undefined;
		state.dispose();
		if (live?.run) {
			host.wakes.queue(sessionId, JOB_NOTICE_QUEUE_KEY, {
				content: "",
				data: { type: "jobs", jobs: [] },
			});
			watchIdle(host, sessionId);
			return;
		}
		const max = noticeWakeMax(host);
		if (!(await reserveNoticeWake(host, sessionId, max))) {
			// The cap refuses the wake, so nothing will wake an idle subagent child for its pending notice: project
			// the `subagent` jobs watching it now, so their parents settle instead of waiting for another change
			// (doc/design/jobs.md "States").
			host.jobs?.sessionChanged(sessionId);
			return;
		}
		const notices = pending.map((job) => jobNoticeOf(job, true));
		try {
			await submitNotice(host, sessionId, jobNoticeRequestId(sessionId, pending), jobNoticesText(pending), {
				type: "jobs",
				jobs: notices,
			});
		} catch (err) {
			await releaseNoticeWake(host, sessionId);
			throw err;
		}
		await jobs.markDelivered(pending.map((job) => job.id));
		// The display surfaces render the placed entry from this model; the channel sends its line where the
		// session's text goes, without marking the session read (doc/design/channels.md "Notifications").
		host.jobNoticePlaced?.(sessionId, notices);
	} finally {
		host.noticeActivity.end(sessionId);
	}
}

/** Startup: deliver every pending notice of a settled job, skipping jobs collected in the meantime. */
export async function wakePendingJobNotices(host: RuntimeHost): Promise<void> {
	const rows = await host.db
		.selectFrom("jobs")
		.select("session_id")
		.distinct()
		.where("notice", "=", "pending")
		.where("state", "=", "settled")
		.where("session_id", "is not", null)
		.execute();
	for (const row of rows) {
		if (!row.session_id) continue;
		try {
			await deliverJobNotices(host, row.session_id);
		} catch (err) {
			console.error(`agent runtime: delivering the completion notices of ${row.session_id} failed:`, err);
		}
	}
}

/** The runtime's notice sink: a job settled uncollected, so wake its owner or hold the notices. */
export async function jobNoticeSettled(host: RuntimeHost, job: JobRow): Promise<void> {
	if (job.notice !== "pending" || job.session_id === null) return;
	await deliverJobNotices(host, job.session_id);
}

/** One wake request id per set of jobs, so a retried submit lands once. */
function jobNoticeRequestId(sessionId: string, jobs: readonly JobRow[]): string {
	const digest = createHash("sha256")
		.update(
			jobs
				.map((job) => `${job.id}:${job.settled_at ?? ""}`)
				.sort()
				.join(","),
		)
		.digest("hex")
		.slice(0, 16);
	return `job-notice:${sessionId}:${digest}`;
}

/** The cap on notice wakes since the session's last user-authored input. */
function noticeWakeMax(host: RuntimeHost): number {
	return host.options.settings?.current().jobs.maxConsecutiveWakes ?? DEFAULT_MAX_CONSECUTIVE_WAKES;
}

/**
 * Whether a completion-notice wake for the session may still run: the read-only form of the check
 * `reserveNoticeWake` makes. The subagent adapter reads it to tell a pending notice that will wake the child
 * from one the cap leaves undeliverable (doc/design/jobs.md "States").
 */
export async function noticeWakeAvailable(host: RuntimeHost, sessionId: string): Promise<boolean> {
	const max = noticeWakeMax(host);
	if (max <= 0) return false;
	const row = await host.db
		.selectFrom("sessions")
		.select("notice_wakes")
		.where("id", "=", sessionId)
		.executeTakeFirst();
	return row !== undefined && row.notice_wakes < max;
}

/**
 * Counts one notice wake against `jobs.max_consecutive_wakes`, atomically on the row read: false means the cap
 * is reached and the notices stay pending. The count is a session column, so a restart does not reset it.
 */
async function reserveNoticeWake(host: RuntimeHost, sessionId: string, max: number): Promise<boolean> {
	if (max <= 0) return false;
	for (let attempt = 0; attempt < 3; attempt++) {
		const row = await host.db
			.selectFrom("sessions")
			.select("notice_wakes")
			.where("id", "=", sessionId)
			.executeTakeFirst();
		if (!row || row.notice_wakes >= max) return false;
		const result = await host.db
			.updateTable("sessions")
			.set({ notice_wakes: row.notice_wakes + 1 })
			.where("id", "=", sessionId)
			.where("notice_wakes", "=", row.notice_wakes)
			.executeTakeFirst();
		if (result.numUpdatedRows > 0n) return true;
	}
	return false;
}

/** Refunds a reserved wake that was never placed (a submit that failed). */
async function releaseNoticeWake(host: RuntimeHost, sessionId: string): Promise<void> {
	await host.db
		.updateTable("sessions")
		.set((eb) => ({ notice_wakes: eb("notice_wakes", "-", 1) as unknown as number }))
		.where("id", "=", sessionId)
		.where("notice_wakes", ">", 0)
		.execute()
		.catch(() => {});
}

/** A user-authored input resets the wake count, so the cap applies to the chain that input started. */
export async function resetNoticeWakes(host: RuntimeHost, sessionId: string): Promise<void> {
	await host.db.updateTable("sessions").set({ notice_wakes: 0 }).where("id", "=", sessionId).execute();
}

/**
 * Waits until a session is quiet (doc/design/scheduling.md "Finish"): its own run is idle, it owns no unsettled
 * job, and no completion notice or held wake can still start a turn. Event-driven: job settles and notice
 * deliveries notify the waiters.
 */
export async function waitForSessionQuiet(host: RuntimeHost, sessionId: string, signal?: AbortSignal): Promise<void> {
	for (;;) {
		if (signal?.aborted || host.closing()) return;
		const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
		if (!row) return;
		const conversation = await conversationOf(host, row);
		if (!conversation) return;
		try {
			await conversation.waitForIdle(signal ? withAbortSignal(signal, host.context) : host.context);
		} catch {
			return;
		}
		const jobs = host.jobs;
		for (;;) {
			if (signal?.aborted || host.closing()) return;
			const seq = host.noticeActivity.seq(sessionId);
			const current = await host.db
				.selectFrom("sessions")
				.select("state")
				.where("id", "=", sessionId)
				.executeTakeFirst();
			if (!current) return;
			const unsettled = jobs === undefined ? 0 : await jobs.unsettledCount(sessionId);
			const noticeBusy = host.noticeActivity.active(sessionId) || host.wakes.hasPrefix(sessionId, JOB_NOTICE_QUEUE_KEY);
			if (current.state === "idle" && unsettled === 0 && !noticeBusy) return;
			if (current.state !== "idle") {
				// The row is ahead of the conversation (a settle or refresh is still writing it) or it is
				// awaiting: wait for the next state change instead of looping on the already-idle conversation.
				await host.noticeActivity.waitForChange(sessionId, seq, signal);
				break;
			}
			const waits: Promise<void>[] = [];
			if (unsettled > 0 && jobs) waits.push(jobs.waitForSessionSettled(sessionId, signal));
			if (noticeBusy) waits.push(host.noticeActivity.waitForChange(sessionId, seq, signal));
			if (waits.length === 0) break;
			await Promise.race(waits);
		}
	}
}

/** A busy session's pending notices, read under the same per-session lock as a wake. */
export async function takePendingJobNotices(host: RuntimeHost, sessionId: string): Promise<JobRow[]> {
	return host.noticeDelivery.run(sessionId, async () => (await host.jobs?.takePendingNotices(sessionId)) ?? []);
}

/** After a restart, wakes the parents of requests that were already waiting (deduplicated by requestId). */
export async function wakePendingAgents(host: RuntimeHost): Promise<void> {
	const requests: { kind: "task" | "task_group" | "external_call"; id: string; session: string }[] = [];
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
	const calls = await host.db
		.selectFrom("external_calls")
		.select(["id", "handler_session_id"])
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "agent")
		.execute();
	for (const row of calls) {
		if (row.handler_session_id) {
			requests.push({ kind: "external_call", id: row.id, session: row.handler_session_id });
		}
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
