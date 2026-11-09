import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
	type CompactionResult,
	SessionFailed,
	type Submission,
	type SubmissionId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { sql } from "kysely";
import type { SessionUser } from "../auth/sessions.ts";
import { UserError } from "../util/errors.ts";
import { exhaustedLevel } from "./quota.ts";
import type { RuntimeHost } from "./runtime-core.ts";
import { loadConversation } from "./runtime-core.ts";
import { settleInput } from "./runtime-state.ts";
import { recordTreeReply } from "./session-replies.ts";

/**
 * Submitting user input and tracking the run it starts (doc/agent-runtime.md#会话状态). A submission is
 * durable's unit of work: the session row points at the latest one, an input that queues behind a running one
 * changes nothing, and the run ends when that latest input settles.
 */

/**
 * Hands the user's message to the session; it runs at once or queues behind the current run. `requestId`
 * makes a retried submit find the first one. `by` is who typed it (the owner, or a user the session is shared with).
 */
export async function submit(
	host: RuntimeHost,
	sessionId: string,
	by: SessionUser,
	text: string,
	requestId: string,
): Promise<string> {
	// A user driving a session shared with them still acts on behalf of its owner (doc/access-control.md).
	return submitInput(host, sessionId, text, requestId, { type: "user", id: by.userId });
}

/** How long a manual compaction waits for durable to say whether it has an old history to summarize. */
const COMPACT_SETTLE_TIMEOUT_MS = 2_000;

/** What a manual compaction did: `nothing` when durable found nothing old enough to summarize. */
export type CompactOutcome = "started" | "nothing" | "failed";

export interface CompactTask {
	taskId: string;
	outcome: CompactOutcome;
}

/**
 * Manually compacts the session (doc/agent-runtime.md#会话): the summary is made in the background and placed at
 * once when the conversation is idle, otherwise at its next boundary. Compaction spends output tokens (D92).
 * The outcome tells the caller whether durable found anything to summarize; a summary that is still being made
 * counts as `started`.
 */
export async function compact(
	host: RuntimeHost,
	sessionId: string,
	by: SessionUser,
	instructions: string | undefined,
): Promise<CompactTask> {
	const { row, conversation } = await loadConversation(host, sessionId);
	if (row.status !== "active") throw new UserError("the session is archived");
	const over = await exhaustedLevel(host.db, sessionId);
	if (over) {
		throw new UserError(
			over === sessionId
				? "the session's token quota is used up; raise it to continue"
				: "a parent session's token quota is used up",
		);
	}
	const taskId = await conversation.compact(instructions, host.context);
	// A manual compaction is a run of its own (doc/agent-runtime.md#会话状态): an idle session shows it while the
	// summary is made. The conditional update revives only the idle row that was read, never a run that started since.
	if (row.state === "idle") {
		const at = new Date().toISOString();
		let revive = host.db
			.updateTable("sessions")
			.set({
				state: "running",
				waiting_kind: null,
				waiting_level_id: null,
				waiting_handler_id: null,
				state_changed_at: at,
				updated_at: at,
			})
			.where("id", "=", sessionId)
			.where("state", "=", "idle");
		revive =
			row.last_submission_id === null
				? revive.where("last_submission_id", "is", null)
				: revive.where("last_submission_id", "=", row.last_submission_id);
		if ((await revive.executeTakeFirst()).numUpdatedRows > 0n) {
			host.sessionList.publishSession(sessionId);
			void trackCompaction(host, sessionId, taskId, row.last_submission_id);
		}
	}
	void host.audit?.record({
		actor: { type: "user", id: by.userId, onBehalfOfUserId: row.owner_user_id },
		action: "session.compacted",
		target: { type: "session", id: sessionId },
		detail: { task_id: String(taskId), ...(instructions ? { instructions_chars: instructions.length } : {}) },
	});
	const outcome = await compactionOutcome(host, taskId);
	return { taskId: String(taskId), outcome };
}

/**
 * Says whether a manual compaction found an old history to summarize (doc/agent-runtime.md#会话): durable's
 * `select` phase completes at once with an empty result when the recent window already holds everything, and
 * otherwise moves on to the summarization model call. A summary still being made counts as `started`.
 */
async function compactionOutcome(host: RuntimeHost, taskId: TaskId<CompactionResult>): Promise<CompactOutcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), COMPACT_SETTLE_TIMEOUT_MS);
	});
	try {
		const settled = await Promise.race([host.harness().waitForTask(taskId, host.context), timeout]);
		if (settled === "timeout") return "started";
		if (settled.state.outcome.status !== "completed") return "failed";
		const { submissionId, entryId } = settled.state.outcome.result;
		return submissionId === undefined && entryId === undefined ? "nothing" : "started";
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Ends the run a manual compaction revived (doc/agent-runtime.md#会话状态): the session is idle again once the summary
 * is placed or the task ends, but only while it is still that run — a newer input or a stop wins.
 */
async function trackCompaction(
	host: RuntimeHost,
	sessionId: string,
	taskId: TaskId<CompactionResult>,
	lastSubmissionId: string | null,
): Promise<void> {
	try {
		const { state } = await host.harness().waitForTask(taskId, host.context);
		if (state.outcome.status === "completed" && state.outcome.result.submissionId !== undefined) {
			const submission = await host.harness().submission(state.outcome.result.submissionId, host.context);
			await submission?.wait(host.context);
		}
		if (host.closing()) return;
		const at = new Date().toISOString();
		let update = host.db
			.updateTable("sessions")
			.set({
				state: "idle",
				waiting_kind: null,
				waiting_level_id: null,
				waiting_handler_id: null,
				state_changed_at: at,
				updated_at: at,
			})
			.where("id", "=", sessionId)
			.where("state", "=", "running");
		update =
			lastSubmissionId === null
				? update.where("last_submission_id", "is", null)
				: update.where("last_submission_id", "=", lastSubmissionId);
		const res = await update.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return;
		await recordTreeReply(host.db, sessionId, "running", "idle");
		host.sessionList.publishSession(sessionId);
	} catch (err) {
		if (!host.closing()) console.error("agent runtime: recording a compaction's end failed:", err);
	}
}

/**
 * Submits a schedule run's fixed prompt (doc/scheduling.md#调度). The request id is derived from the
 * schedule and the fire time, so a resubmitted run returns its first submission instead of sending twice;
 * `checkQuota: false` is for that recovery path, where the run may have exhausted the quota by finishing.
 */
export async function submitAsSchedule(
	host: RuntimeHost,
	sessionId: string,
	scheduleId: string,
	text: string,
	requestId: string,
	options: { checkQuota?: boolean } = {},
): Promise<string> {
	return submitInput(
		host,
		sessionId,
		text,
		requestId,
		{ type: "schedule", id: scheduleId },
		options.checkQuota !== false,
	);
}

async function submitInput(
	host: RuntimeHost,
	sessionId: string,
	text: string,
	requestId: string,
	actor: { type: string; id: string },
	checkQuota = true,
): Promise<string> {
	const { row, conversation } = await loadConversation(host, sessionId);
	if (row.status !== "active") throw new UserError("the session is archived");
	if (checkQuota) {
		const over = await exhaustedLevel(host.db, sessionId);
		if (over) {
			throw new UserError(
				over === sessionId
					? "the session's token quota is used up; raise it to continue"
					: "a parent session's token quota is used up",
			);
		}
	}
	const submission = await conversation.submit({ type: "input", content: text, requestId }, host.context);
	await recordInput(host, sessionId, submission);
	void host.audit?.record({
		actor: { ...actor, onBehalfOfUserId: row.owner_user_id },
		action: "session.message",
		target: { type: "session", id: sessionId },
		detail: { submission_id: String(submission.id), chars: text.length },
	});
	return String(submission.id);
}

/**
 * Records a new input and revives an idle session in one row update. A retried older submission is ignored,
 * so it cannot roll `last_submission_id` back or revive a session that a newer input is driving. An input
 * that queues behind a running one changes nothing: the session already runs or waits.
 */
export async function recordInput(host: RuntimeHost, sessionId: string, submission: Submission): Promise<boolean> {
	const id = String(submission.id);
	for (let attempt = 0; attempt < 3; attempt++) {
		const row = await host.db
			.selectFrom("sessions")
			.select("last_submission_id")
			.where("id", "=", sessionId)
			.executeTakeFirst();
		if (!row || !isNewerSubmission(id, row.last_submission_id)) return false;
		const at = new Date().toISOString();
		let update = host.db
			.updateTable("sessions")
			.set({
				last_submission_id: id,
				updated_at: at,
				// Only a new input revives an idle session; a wait that is already there stays until it ends.
				state: sql`case when state = 'idle' then 'running' else state end`,
				state_changed_at: sql`case when state = 'idle' then ${at} else state_changed_at end`,
			})
			.where("id", "=", sessionId);
		update =
			row.last_submission_id === null
				? update.where("last_submission_id", "is", null)
				: update.where("last_submission_id", "=", row.last_submission_id);
		const res = await update.executeTakeFirst();
		if (res.numUpdatedRows === 0n) continue;
		host.sessionList.publishSession(sessionId);
		// The list shows "last activity": a user message at submission, the assistant's at run end. Streaming
		// commits in between do not touch the row (doc/webui.md#会话列表).
		void submission
			.wait(host.context)
			.then(async () => {
				await settleInput(host, sessionId, id);
			})
			.catch((err: unknown) => {
				// A closed Harness rejects every pending wait; the reopen path reconciles, and the re-armed
				// watch records the end then. Anything else must not vanish.
				if (host.closing() || err instanceof SessionFailed) return;
				if (err instanceof Error && err.message === "Harness is closed") return;
				console.error("agent runtime: recording a run's end failed:", err);
			});
		return true;
	}
	return false;
}

function isNewerSubmission(candidate: string, current: string | null): boolean {
	if (current === null) return true;
	try {
		return BigInt(candidate) > BigInt(current);
	} catch {
		return false;
	}
}

/** Waits for a submission to settle and says how it ended, without reading or committing its answer. */
export async function waitForSubmission(
	host: RuntimeHost,
	submissionId: string,
	signal?: AbortSignal,
): Promise<{ status: "done" } | { status: "unanswered"; reason: string }> {
	const context: Context = signal ? withAbortSignal(signal, host.context) : host.context;
	const submission = await host.harness().submission(Number(submissionId) as unknown as SubmissionId, context);
	if (!submission) return { status: "unanswered", reason: "missing" };
	const settled = await submission.wait(context);
	return settled.status === "done" ? { status: "done" } : { status: "unanswered", reason: settled.reason };
}

/**
 * Request ids of the submissions still queued or placed (doc/scheduling.md#调度): a scheduled run whose
 * submission has not settled is still active after a restart, even when its run row already says `preempted`.
 */
export async function unsettledSubmissionRequests(host: RuntimeHost): Promise<Set<string>> {
	const { submissions } = await host.harness().inspect(host.context);
	return new Set(
		submissions.flatMap((submission) => (submission.requestId === undefined ? [] : [submission.requestId])),
	);
}
