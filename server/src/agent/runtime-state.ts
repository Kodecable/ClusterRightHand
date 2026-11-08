import type { SubmissionId } from "@earendil-works/pi-durable";
import { sql } from "kysely";
import type { SessionUser } from "../auth/sessions.ts";
import { exhaustedLevel, exhaustedLevels } from "./quota.ts";
import type { RuntimeHost } from "./runtime-core.ts";
import { parentOf, type SessionRow } from "./session-chain.ts";
import {
	nonIdleSessions,
	type SessionState,
	type SessionWait,
	sessionsWithSubmissions,
	setSessionState,
} from "./session-state.ts";
import { maybeGenerateTitle } from "./title.ts";

/**
 * A session's run state (doc/agent-runtime.md#会话状态): recomputed from durable and the session's wait
 * sources while it is live, corrected at startup after a restart, and ended when its latest input settles.
 * Only a new input revives an idle session; every other write keeps it idle or corrects a live run.
 */

/** Sessions per `IN (...)` lookup at startup; SQLite caps bound parameters far below the session count. */
const RECONCILE_CHUNK = 500;

/** The columns the state computation reads from a session row. */
type StateRow = Pick<
	SessionRow,
	"id" | "state" | "waiting_kind" | "waiting_level_id" | "waiting_handler_id" | "last_submission_id"
>;

/** The state a session deserves and what an awaiting one waits for. */
type DesiredState = { state: SessionState; wait: SessionWait | null };

/**
 * Recomputes a session's state from durable and its wait sources (doc/agent-runtime.md#会话状态): a quota wait
 * first, then a task waiting for approval or a signature, otherwise running while its latest input is
 * unsettled. An idle session is never revived here — only a new input does that — so a late correction
 * cannot restart a run that already ended.
 *
 * `StateRefreshes.run` serializes and coalesces refreshes of the same session: a request while one is running
 * marks it dirty and shares its promise, and the running one recomputes once more after it finishes, so the
 * last write is always computed from data read after the latest request.
 */
export function refreshState(host: RuntimeHost, sessionId: string): Promise<SessionState> {
	return host.refreshes.run(sessionId, () => refreshStateOnce(host, sessionId));
}

/** One recomputation of the session's state from the data read now; `refreshState` runs it in order. */
async function refreshStateOnce(host: RuntimeHost, sessionId: string): Promise<SessionState> {
	const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
	if (!row) return "idle";
	if (row.state === "idle") return "idle";
	const settled = await inputSettled(host, row);
	const desired = await desiredState(host, row, settled);
	// The write is conditional on the row still being live: the run may have settled while the reads above
	// ran, and a recompute must not revive it (doc/agent-runtime.md#会话状态).
	const write = await setSessionState(host.db, sessionId, desired.state, desired.wait, { onlyIfLive: true });
	if (!write.applied) return "idle";
	host.sessionList.publishSession(sessionId);
	// Approval/quota changes alter the handler's inbox; write-state and cache invalidation are adjacent.
	const changed =
		row.state !== desired.state ||
		row.waiting_kind !== (desired.wait?.kind ?? null) ||
		row.waiting_level_id !== (desired.wait?.levelId ?? null);
	if (changed) host.inboxes.clear();
	return desired.state;
}

/**
 * Recomputes several sessions' states with a constant number of reads, then hands only the rows whose stored
 * state is stale to `refreshState` (which re-reads and writes them with the same coalescing as every other
 * caller). A read path such as `subagentSessions` needs current states but must not pay a full recompute per
 * child; a row already in the expected state costs no write at all.
 */
export async function refreshStates(host: RuntimeHost, rows: readonly StateRow[]): Promise<Map<string, SessionState>> {
	const states = new Map<string, SessionState>();
	const live: StateRow[] = [];
	for (const row of rows) {
		if (row.state === "idle") states.set(row.id, "idle");
		else live.push(row);
	}
	if (live.length === 0) return states;

	// A recompute already running for a row must be shared, not duplicated: refreshState coalesces it and reads
	// the latest data itself.
	const pending = new Map<string, Promise<SessionState>>();
	const batched: StateRow[] = [];
	for (const row of live) {
		if (host.refreshes.isRunning(row.id)) pending.set(row.id, refreshState(host, row.id));
		else batched.push(row);
	}

	if (batched.length > 0) {
		// Durable's queued/placed submissions are exactly the unsettled ones; one inspect reads them all,
		// instead of two durable reads per child.
		const { submissions } = await host.harness().inspect(host.context);
		const unsettled = new Set(submissions.map((submission) => String(submission.id)));
		const quotaLevels = await exhaustedLevels(
			host.db,
			batched.filter((row) => row.state === "awaiting" && row.waiting_kind === "quota").map((row) => row.id),
		);
		const waits = await taskWaitKinds(
			host.db,
			batched.map((row) => row.id),
		);
		for (const row of batched) {
			const quotaLevel = quotaLevels.get(row.id);
			let desired: DesiredState;
			if (quotaLevel) {
				desired = { state: "awaiting", wait: { kind: "quota", levelId: quotaLevel } };
			} else if (!row.last_submission_id || !unsettled.has(row.last_submission_id)) {
				desired = { state: "idle", wait: null };
			} else {
				const kind = waits.get(row.id);
				desired = kind ? { state: "awaiting", wait: { kind, levelId: null } } : { state: "running", wait: null };
			}
			// A non-root quota wait owes its handler (the level's parent). A row that lost it needs the full
			// recompute that sets it; everything else in the expected state needs no write.
			const missingHandler =
				desired.state === "awaiting" &&
				desired.wait?.kind === "quota" &&
				row.waiting_handler_id === null &&
				desired.wait.levelId !== row.id;
			if (sameState(row, desired) && !missingHandler && !host.refreshes.isRunning(row.id)) {
				states.set(row.id, desired.state);
				// `refreshState` publishes every live row it recomputes, even when the state is unchanged; keep
				// that signal (a later fetch is a no-op when there are no subscribers).
				host.sessionList.publishSession(row.id);
				continue;
			}
			pending.set(row.id, refreshState(host, row.id));
		}
	}

	for (const [id, state] of pending) states.set(id, await state);
	return states;
}

/** Whether the row already stores exactly the state the batched recompute found. */
function sameState(row: StateRow, desired: DesiredState): boolean {
	const kind = desired.state === "awaiting" ? (desired.wait?.kind ?? null) : null;
	const levelId = desired.state === "awaiting" && kind === "quota" ? (desired.wait?.levelId ?? null) : null;
	return row.state === desired.state && row.waiting_kind === kind && row.waiting_level_id === levelId;
}

/** The state a live (or stale) row deserves; `settled` says its latest input's run is over. */
async function desiredState(
	host: RuntimeHost,
	row: StateRow,
	settled: boolean,
): Promise<{ state: SessionState; wait: SessionWait | null }> {
	const quotaLevel = await quotaWaitLevel(host, row);
	if (quotaLevel) return { state: "awaiting", wait: { kind: "quota", levelId: quotaLevel } };
	if (settled) return { state: "idle", wait: null };
	const kind = await taskWaitKind(host, row.id);
	if (kind) return { state: "awaiting", wait: { kind, levelId: null } };
	return { state: "running", wait: null };
}

/** Whether the latest input's run is over (done or unanswered); no input at all counts as settled. */
async function inputSettled(host: RuntimeHost, row: Pick<SessionRow, "last_submission_id">): Promise<boolean> {
	if (!row.last_submission_id) return true;
	const submission = await host
		.harness()
		.submission(Number(row.last_submission_id) as unknown as SubmissionId, host.context);
	if (!submission) return true;
	const status = await submission.status(host.context);
	return status.status === "done" || status.status === "unanswered";
}

/**
 * The level a quota wait still points at: recomputed from the chain, because a grant of one level may expose
 * the next one, and no longer exhausted at all ends the wait.
 */
async function quotaWaitLevel(
	host: RuntimeHost,
	row: Pick<SessionRow, "id" | "state" | "waiting_kind">,
): Promise<string | undefined> {
	if (row.state !== "awaiting" || row.waiting_kind !== "quota") return undefined;
	return exhaustedLevel(host.db, row.id);
}

/**
 * What the session's own tool calls wait for: an approval outranks a signature (doc/agent-runtime.md#会话状态).
 * An approval counts only when a handler is assigned: a task that passed its rules passes through
 * `awaiting_approval` for the instant before dispatch without one (doc/execution-plane.md#状态机), and that
 * transient row is nothing anyone could approve.
 */
async function taskWaitKind(host: RuntimeHost, sessionId: string): Promise<"approval" | "authorization" | undefined> {
	const waiting = async (state: "awaiting_approval" | "awaiting_authorization"): Promise<boolean> => {
		for (const table of ["tasks", "task_groups"] as const) {
			let query = host.db
				.selectFrom(table)
				.select("id")
				.where("actor_type", "in", ["session", "subagent"])
				.where("actor_id", "=", sessionId)
				.where("state", "=", state);
			if (state === "awaiting_approval") query = query.where("handler_type", "is not", null);
			const row = await query.limit(1).executeTakeFirst();
			if (row) return true;
		}
		return false;
	};
	if (await waiting("awaiting_approval")) return "approval";
	if (await waiting("awaiting_authorization")) return "authorization";
	return undefined;
}

/**
 * `taskWaitKind` for several sessions at once: one query per table, then the same approval-over-signature
 * priority per session. Only sessions with a wait are in the result.
 */
async function taskWaitKinds(
	db: RuntimeHost["db"],
	sessionIds: readonly string[],
): Promise<Map<string, "approval" | "authorization">> {
	const out = new Map<string, "approval" | "authorization">();
	if (sessionIds.length === 0) return out;
	for (const table of ["tasks", "task_groups"] as const) {
		const rows = await db
			.selectFrom(table)
			.select(["actor_id", "state", "handler_type"])
			.where("actor_type", "in", ["session", "subagent"])
			.where("actor_id", "in", [...sessionIds])
			.where("state", "in", ["awaiting_approval", "awaiting_authorization"])
			.execute();
		for (const row of rows) {
			if (row.state === "awaiting_approval") {
				// A row without a handler is the instant before dispatch, not an approval anyone can decide.
				if (row.handler_type !== null) out.set(row.actor_id, "approval");
			} else if (out.get(row.actor_id) !== "approval") {
				out.set(row.actor_id, "authorization");
			}
		}
	}
	return out;
}

/**
 * Ends the session's run when its latest input settles (done, rejected or aborted alike): the session is
 * idle until a new input. Only the latest input's settlement writes idle, so an older run cannot stop a
 * newer one (doc/agent-runtime.md#会话状态).
 *
 * The run end is also where title generation is triggered for a root that still wants a title
 * (doc/agent-runtime.md#标题生成); `generateTitle: false` is for a run that already ended before a restart —
 * generation is not persisted, so the next run end triggers it instead.
 */
export async function settleInput(
	host: RuntimeHost,
	sessionId: string,
	submissionId: string,
	options: { generateTitle?: boolean } = {},
): Promise<void> {
	if (host.closing()) return;
	const row = await host.db
		.selectFrom("sessions")
		.select(["last_submission_id", "parent_session_id", "title_pending"])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!row || row.last_submission_id !== submissionId) return;
	const at = new Date().toISOString();
	await host.db
		.updateTable("sessions")
		.set({
			state: "idle",
			waiting_kind: null,
			waiting_level_id: null,
			waiting_handler_id: null,
			state_changed_at: sql`case when state = 'idle' then state_changed_at else ${at} end`,
			updated_at: at,
		})
		.where("id", "=", sessionId)
		.where("last_submission_id", "=", submissionId)
		.execute();
	host.sessionList.publishSession(sessionId);
	host.inboxes.forget(sessionId);
	// A tool call that ended without its task (aborted by durable, abandoned after restarts) left the task
	// waiting for a decision nobody will act on: the run is over, so end those waits too.
	if (!host.sessionFlags.isStopping(sessionId)) {
		await endSessionWork(host, [sessionId], "the session's run ended", { includeRunning: false });
	}
	// Background: the run end never waits for the title. A stopped run, a child and a scheduled run have no
	// pending title (or must not start one); the generator re-checks the row anyway.
	if (
		options.generateTitle !== false &&
		!host.sessionFlags.isStopping(sessionId) &&
		row.parent_session_id === null &&
		row.title_pending === 1
	) {
		maybeGenerateTitle(host, sessionId, submissionId);
	}
}

/**
 * Ends what sessions left waiting when their work stopped: approvals are rejected and signature waits
 * cancelled with `reason`; with `includeRunning` (a stop) dispatched and running tasks are cancelled too.
 * The tools' own abort signal is not used for this, because it also fires when crhs shuts down and the call
 * must then reattach to its task after the restart.
 */
export async function endSessionWork(
	host: RuntimeHost,
	sessions: readonly string[],
	reason: string,
	options: { includeRunning: boolean; by?: SessionUser },
): Promise<void> {
	if (sessions.length === 0) return;
	const { includeRunning, by } = options;
	const decision = {
		decision: "rejected" as const,
		by: { type: "user", id: by?.userId ?? "system", ...(by ? { onBehalfOfUserId: by.userId } : {}) },
		at: new Date().toISOString(),
		reason,
	};
	const waiting = ["awaiting_approval", "awaiting_authorization"] as const;
	const live = ["dispatched", "running"] as const;
	const tasks = await host.db
		.selectFrom("tasks")
		.select(["id", "state"])
		.where("actor_id", "in", sessions)
		.where("task_group_id", "is", null)
		.where("state", "in", includeRunning ? [...waiting, ...live] : [...waiting])
		.execute();
	for (const row of tasks) {
		if (row.state === "awaiting_approval") await host.cluster.decide(row.id, decision);
		else
			await host.cluster.cancelTask(
				row.id,
				reason,
				by ? { type: "user", id: by.userId, onBehalfOfUserId: by.userId } : undefined,
			);
	}
	const groups = await host.db
		.selectFrom("task_groups")
		.select(["id", "state"])
		.where("actor_id", "in", sessions)
		.where("state", "in", [...waiting, "running"])
		.execute();
	for (const group of groups) {
		if (group.state === "awaiting_approval") {
			await host.taskGroups.decide(group.id, decision);
			continue;
		}
		// A running group may still have members waiting for their signature; a stop also cancels the rest.
		const members = await host.db
			.selectFrom("tasks")
			.select("id")
			.where("task_group_id", "=", group.id)
			.where("state", "in", includeRunning ? ["awaiting_authorization", ...live] : ["awaiting_authorization"])
			.execute();
		for (const t of members)
			await host.cluster.cancelTask(
				t.id,
				reason,
				by ? { type: "user", id: by.userId, onBehalfOfUserId: by.userId } : undefined,
			);
	}
}

/**
 * Startup reconciliation (doc/agent-runtime.md#会话状态), run after durable resumed the runs and before
 * crhs accepts requests: the cached state of every stale candidate is corrected against durable and the
 * wait sources. A session is a candidate only when its row is not `idle` (it claims a live run or a wait),
 * or when its latest durable input is still unsettled:
 * - a run whose latest input already settled becomes idle;
 * - an unsettled one is awaiting on its quota wait or on a task waiting for approval/signature, else running;
 * - an idle row with an unsettled input becomes running.
 * An idle row outside that set needs no check: `recordInput` writes `running` in the same statement that
 * advances `last_submission_id`, and `settleInput` writes `idle` only after the latest input settled (a new
 * session starts idle with no input at all), so "idle and settled" holds by construction. The `0029`
 * migration maps old `active`/`stopped` rows to `idle` without knowing which runs survived; those are
 * exactly the rows candidate 2 finds through their unsettled submission. The system is sized for far more
 * idle sessions than active ones (doc/webui.md: 100,000 sessions), so only candidates may cost a durable
 * read. Each correction is logged, not audited. The write is conditional on the row read, so a state write
 * by a resumed run wins the race instead of being clobbered.
 */
export async function reconcileSessionStates(host: RuntimeHost): Promise<void> {
	const candidates = new Map<string, SessionRow>();
	// Candidate 1: rows that claim a live run or a wait.
	const stale = await nonIdleSessions(host.db).execute();
	for (const row of stale) candidates.set(row.id, row);
	// Candidate 2: queued and placed submissions are durable's one answer to "what has not settled"; map
	// them back to their sessions through `last_submission_id`, in chunks, never with a query per row.
	const { submissions } = await host.harness().inspect(host.context);
	const unsettled = new Set(
		submissions.flatMap((submission) => (submission.type === "input" ? [String(submission.id)] : [])),
	);
	const unresolved = [...unsettled];
	for (let start = 0; start < unresolved.length; start += RECONCILE_CHUNK) {
		const rows = await sessionsWithSubmissions(host.db, unresolved.slice(start, start + RECONCILE_CHUNK)).execute();
		for (const row of rows) if (!candidates.has(row.id)) candidates.set(row.id, row);
	}
	for (const row of candidates.values()) {
		// A candidate found through an unsettled submission is already known not to have settled; the others
		// have a non-idle row, whose latest input must be read to tell idle from running.
		const settled =
			row.last_submission_id !== null && unsettled.has(row.last_submission_id) ? false : await inputSettled(host, row);
		let desired: { state: SessionState; wait: SessionWait | null };
		if (settled) {
			desired = { state: "idle", wait: null };
		} else {
			const quotaLevel = await quotaWaitLevel(host, row);
			const waitKind = quotaLevel ? undefined : await taskWaitKind(host, row.id);
			desired = quotaLevel
				? { state: "awaiting", wait: { kind: "quota", levelId: quotaLevel } }
				: waitKind
					? { state: "awaiting", wait: { kind: waitKind, levelId: null } }
					: { state: "running", wait: null };
		}
		// A resumed run was not recorded by recordInput, so nothing would write idle when it ends: watch it.
		if (!settled && row.last_submission_id) watchSubmission(host, row.id, row.last_submission_id);
		const kind = desired.wait?.kind ?? null;
		const levelId = desired.wait?.levelId ?? null;
		if (row.state === desired.state && row.waiting_kind === kind && row.waiting_level_id === levelId) continue;
		const at = new Date().toISOString();
		let update = host.db
			.updateTable("sessions")
			.set({
				state: desired.state,
				waiting_kind: kind,
				waiting_level_id: levelId,
				waiting_handler_id: kind === "quota" && levelId ? await parentOf(host.db, levelId) : null,
				state_changed_at: at,
			})
			.where("id", "=", row.id)
			.where("state", "=", row.state);
		update =
			row.state_changed_at === null
				? update.where("state_changed_at", "is", null)
				: update.where("state_changed_at", "=", row.state_changed_at);
		const res = await update.executeTakeFirst();
		if (res.numUpdatedRows === 0n) continue;
		const before = row.state === "awaiting" ? `awaiting/${row.waiting_kind ?? "?"}` : row.state;
		const after = desired.state === "awaiting" ? `awaiting/${kind ?? "?"}` : desired.state;
		console.log(`session state reconciled: ${row.id} ${before} -> ${after}`);
	}
}

/** Records the end of a submission that survived a restart (its input was recorded by the previous process). */
function watchSubmission(host: RuntimeHost, sessionId: string, submissionId: string): void {
	void (async () => {
		const submission = await host.harness().submission(Number(submissionId) as unknown as SubmissionId, host.context);
		if (!submission) return;
		await submission.wait(host.context);
		await settleInput(host, sessionId, submissionId, { generateTitle: false });
	})().catch((err: unknown) => {
		console.error("agent runtime: recording a resumed run's end failed:", err);
	});
}

/**
 * Startup reconciliation of approval and signature waits (doc/agent-runtime.md#会话状态): a task or group
 * acting for a session that is idle after reconcileSessionStates belongs to a run that is over, so its wait
 * is ended. Only waiting rows are read, never every session.
 */
export async function endOrphanWaits(host: RuntimeHost): Promise<void> {
	const waiting = ["awaiting_approval", "awaiting_authorization"] as const;
	const orphaned = new Set<string>();
	for (const table of ["tasks", "task_groups"] as const) {
		const rows = await host.db
			.selectFrom(table)
			.innerJoin("sessions", "sessions.id", `${table}.actor_id`)
			.select(`${table}.actor_id as actorId`)
			.where(`${table}.actor_type`, "in", ["session", "subagent"])
			.where(`${table}.state`, "in", [...waiting])
			.where("sessions.state", "=", "idle")
			.execute();
		for (const row of rows) orphaned.add(row.actorId);
	}
	const running = await host.db
		.selectFrom("tasks")
		.innerJoin("task_groups", "task_groups.id", "tasks.task_group_id")
		.innerJoin("sessions", "sessions.id", "task_groups.actor_id")
		.select("task_groups.actor_id as actorId")
		.where("task_groups.state", "=", "running")
		.where("tasks.state", "=", "awaiting_authorization")
		.where("sessions.state", "=", "idle")
		.execute();
	for (const row of running) orphaned.add(row.actorId);
	if (orphaned.size === 0) return;
	console.log(`agent runtime: ending the waits of ${orphaned.size} session(s) whose run is over`);
	await endSessionWork(host, [...orphaned], "the session's run ended", { includeRunning: false });
}
