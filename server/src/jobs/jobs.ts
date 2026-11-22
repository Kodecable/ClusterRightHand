/**
 * The job service (doc/design/jobs.md): creates job rows idempotently from a producer's tool call, recomputes
 * their projection through the kind's adapter (serialized per job id, like a task's writes), waits, cancels,
 * renders and lists. The job layer reads the records behind jobs only through the adapters.
 */
import type { TaskOutcome } from "@crh/api";
import type { Audit } from "../audit/audit.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { Actor } from "../cluster/types.ts";
import type { CallRunner } from "../extensions/call-runner.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import type { JobState } from "../storage/schema.ts";
import type { ToolContext } from "../tools/catalog.ts";
import { jobId } from "../util/id.ts";
import { KeyedQueue } from "../util/keyed-queue.ts";
import { errorResult, type ToolResult } from "../util/tool-result.ts";
import { callJobSource, serializeCallResult } from "./call.ts";
import { execJobSource } from "./exec.ts";
import { subagentJobSource } from "./subagent.ts";
import type { ExecJobRenderers, JobRow, JobSource, JobWaitOptions, NewJob, SubagentJobRuntime } from "./types.ts";

export interface JobsOptions {
	db: Db;
	cluster: Cluster;
	taskGroups: TaskGroups;
	/** Records a cancelled call, like an aborted tool call does (doc/design/extensions.md "External calls"). */
	audit?: Audit;
	/** The exec renderers, from the tools layer (doc/design/jobs.md "Adapters"). */
	execRenderers: ExecJobRenderers;
	/** The crhs-owned extension calls the `call` adapter follows and cancels. */
	callRunner: CallRunner;
}

export class Jobs {
	readonly #db: Db;
	/** The runner shared with the tools and the runtime's stop path. */
	readonly callRunner: CallRunner;
	readonly #sources = new Map<JobRow["kind"], JobSource>();
	/** Serializes a job's projection writes, so two quick record changes cannot land out of order. */
	readonly #queue = new KeyedQueue("job projection queue");
	/**
	 * Serializes a scope's job-limit check with the job creation it guards (doc/design/jobs.md "Limit"), so two
	 * parallel tool calls cannot both read the count below the limit and both start a job.
	 */
	readonly #limitQueue = new KeyedQueue("job limit queue");
	/** Projections started by a record-change hook; drain() waits for them before the database closes. */
	readonly #pending = new Set<Promise<void>>();
	/**
	 * Live waits by job id, counted (doc/design/jobs.md "Completion notices"): a job that settles while one is
	 * open is *collected*, not pending, because the waiter will return its result.
	 */
	readonly #waiting = new Map<string, number>();
	/**
	 * Jobs a stop or a session deletion cancels: their settle is collected rather than pending, so stopping a
	 * session does not wake it with a completion notice (doc/design/jobs.md "Lifecycle and retention").
	 */
	readonly #silenced = new Set<string>();
	/** Notice deliveries in flight per session, so a "settled" waiter does not race the wake (scheduler, finish). */
	readonly #settling = new Map<string, number>();
	/** Bumped on every change of a session's jobs; waiters compare it so no change between a read and a wait is lost. */
	readonly #settleSeq = new Map<string, number>();
	readonly #settleWaiters = new Map<string, Set<() => void>>();
	/** Listeners of projection changes (the session event stream); jobs never imports the API layer. */
	readonly #listeners = new Set<(job: JobRow) => void>();
	#subagent: SubagentJobRuntime | undefined;
	#noticeSink: ((job: JobRow) => Promise<void> | void) | undefined;

	constructor(options: JobsOptions) {
		this.#db = options.db;
		this.callRunner = options.callRunner;
		this.#sources.set("exec", execJobSource(options.cluster, options.taskGroups, options.execRenderers));
		this.#sources.set("call", callJobSource(options.db, options.callRunner, options.audit));
		this.#sources.set(
			"subagent",
			subagentJobSource(options.db, () => this.#subagent),
		);
		// The records notify the job layer through these hooks; neither the Cluster nor the agent layer imports
		// jobs (doc/design/jobs.md "Job model").
		options.cluster.onTaskChanged = (taskId) => this.changed("task", taskId);
		options.cluster.onGroupChanged = (groupId) => this.changed("task_group", groupId);
		options.taskGroups.onGroupSettled = (groupId) => this.changed("task_group", groupId);
	}

	/** Gives the subagent adapter the runtime operations it needs, once the runtime exists. */
	attachSubagent(runtime: SubagentJobRuntime): void {
		this.#subagent = runtime;
	}

	/**
	 * Subscribes to projection changes (doc/design/jobs.md "API"): the session event route forwards them as
	 * `job.changed` events. The job layer stays free of the API layer: the listener receives the row.
	 */
	onChanged(listener: (job: JobRow) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Gives the job layer the runtime's completion-notice delivery (doc/design/jobs.md "Completion notices"): a
	 * job that settles uncollected calls it with the settled row, and the runtime wakes its owner or leaves the
	 * notices for the next tool result. Awaiting it keeps a settle and its notice one step for a session that is
	 * waiting to become final (a scheduled run).
	 */
	attachNoticeSink(sink: (job: JobRow) => Promise<void> | void): void {
		this.#noticeSink = sink;
	}

	/** The job a tool call already created, so a replay is not blocked by the running limit. */
	async forCall(kind: JobRow["kind"], callKey: string): Promise<JobRow | undefined> {
		return this.get(jobId(kind, callKey));
	}

	/** Counts a live wait on the job until the returned function is called (a starting tool or `job_wait`). */
	beginWait(id: string): () => void {
		this.#waiting.set(id, (this.#waiting.get(id) ?? 0) + 1);
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			const left = (this.#waiting.get(id) ?? 1) - 1;
			if (left <= 0) this.#waiting.delete(id);
			else this.#waiting.set(id, left);
		};
	}

	/**
	 * Runs `work` under the scope's job-limit lock; the caller re-checks the count inside it and creates the job
	 * there, so a parallel start of the same scope cannot slip between the check and the creation.
	 */
	withLimitLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
		return this.#limitQueue.run(scope, work);
	}

	/**
	 * Marks a settled job collected by a reader (doc/design/jobs.md "Completion notices"): its notice becomes
	 * `collected`, withdrawing one not yet delivered. Called after a starting tool's own wait and by `job_wait`;
	 * an unsettled job is not collected (a reader that got no result must not swallow the settle's notice).
	 */
	async collect(id: string): Promise<void> {
		// Only a settled job can be collected: an unsettled one is still running (or about to settle) and its
		// notice is decided by the settle projection, not by a reader that did not get a result.
		await this.#queue.run(id, async () => {
			const current = await this.get(id);
			if (current?.state !== "settled") return;
			if (current.notice === "pending" || current.notice === "delivered") {
				await this.#db.updateTable("jobs").set({ notice: "collected" }).where("id", "=", id).execute();
			}
			// A live job's settle is collected by its wait; the waiter should see it now.
			this.#notifySettled(current.session_id);
		});
	}

	/** A session's settled jobs whose notice is still pending, oldest settle first. */
	async pendingNotices(sessionId: string): Promise<JobRow[]> {
		return this.#db
			.selectFrom("jobs")
			.selectAll()
			.where("session_id", "=", sessionId)
			.where("state", "=", "settled")
			.where("notice", "=", "pending")
			.orderBy("settled_at")
			.orderBy("id")
			.execute();
	}

	/**
	 * Reads a session's pending notices for placement in a tool result or a wake, marking them delivered. A
	 * notice collected between the read and the write is left out (doc/design/jobs.md "State").
	 */
	async takePendingNotices(sessionId: string): Promise<JobRow[]> {
		const pending = await this.pendingNotices(sessionId);
		if (pending.length === 0) return [];
		const ids = pending.map((job) => job.id);
		await this.#db
			.updateTable("jobs")
			.set({ notice: "delivered" })
			.where("id", "in", ids)
			.where("notice", "=", "pending")
			.execute();
		this.#notifySettled(sessionId);
		return this.#db
			.selectFrom("jobs")
			.selectAll()
			.where("id", "in", ids)
			.where("notice", "=", "delivered")
			.orderBy("settled_at")
			.orderBy("id")
			.execute();
	}

	/** Marks the notice of these jobs delivered (a placed `crh.notice` entry). */
	async markDelivered(ids: readonly string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.#db
			.updateTable("jobs")
			.set({ notice: "delivered" })
			.where("id", "in", [...ids])
			.where("notice", "=", "pending")
			.execute();
	}

	/** The session's unsettled jobs (doc/design/jobs.md "Limit" and "Scheduled runs"). */
	async unsettledCount(sessionId: string): Promise<number> {
		const row = await this.#db
			.selectFrom("jobs")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("session_id", "=", sessionId)
			.where("state", "!=", "settled")
			.executeTakeFirst();
		return Number(row?.count ?? 0);
	}

	/** An API token's unsettled jobs; an MCP caller has no session (doc/design/jobs.md "Limit"). */
	async unsettledTokenCount(tokenId: string): Promise<number> {
		const row = await this.#db
			.selectFrom("jobs")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("actor_type", "=", "api_token")
			.where("actor_id", "=", tokenId)
			.where("state", "!=", "settled")
			.executeTakeFirst();
		return Number(row?.count ?? 0);
	}

	/** Notice deliveries in flight for the session; a scheduled run is not final while one is. */
	settlingCount(sessionId: string): number {
		return this.#settling.get(sessionId) ?? 0;
	}

	/**
	 * Resolves once the session owns no unsettled job and no settle is mid-notice. Event-driven: a job change,
	 * a collect or a finished notice delivery notifies the waiters, so callers never poll.
	 */
	async waitForSessionSettled(sessionId: string, signal?: AbortSignal): Promise<void> {
		for (;;) {
			if (signal?.aborted) return;
			const seq = this.#settleSeq.get(sessionId) ?? 0;
			if ((await this.unsettledCount(sessionId)) === 0 && this.settlingCount(sessionId) === 0) return;
			await this.#waitForChange(sessionId, seq, signal);
		}
	}

	/**
	 * Marks every unsettled job of these sessions as silenced before their work is stopped (doc/design/jobs.md
	 * "Lifecycle and retention"): a job that settles while the stop runs is `collected`, not `pending`. A job
	 * that already settled with a pending notice is written `collected` too, and the durable marker keeps a
	 * restart from waking the session with it either.
	 */
	async silenceSessionJobs(sessionIds: readonly string[]): Promise<void> {
		if (sessionIds.length === 0) return;
		const ids = [...new Set(sessionIds)];
		const rows = await this.#db
			.selectFrom("jobs")
			.select(["id", "state"])
			.where("session_id", "in", ids)
			// Unsettled jobs, and settled ones whose notice is still pending: a settle that raced the stop must
			// not leave a notice for a later process to deliver.
			.where((eb) => eb.or([eb("state", "!=", "settled"), eb("notice", "=", "pending")]))
			.execute();
		if (rows.length === 0) return;
		// Before the write: a projection that read the row before the update still sees the in-memory mark. Only
		// unsettled jobs are marked: a settled job never settles again, so its mark would never be removed, and
		// the durable write below already silences its pending notice.
		for (const row of rows) if (row.state !== "settled") this.#silenced.add(row.id);
		await this.#db
			.updateTable("jobs")
			.set({ notice: "collected" })
			.where(
				"id",
				"in",
				rows.map((row) => row.id),
			)
			.where("notice", "!=", "collected")
			.execute();
	}

	/** Cancels every unsettled job a session started, through each job's own path (stop, deletion). */
	async cancelSessionJobs(sessionId: string, by?: Actor): Promise<void> {
		// A stop must never be a completion to wake for, even if a record settles mid-cancel; the marker is kept
		// in the row so the next process honors it too.
		await this.silenceSessionJobs([sessionId]);
		const rows = await this.#db
			.selectFrom("jobs")
			.selectAll()
			.where("session_id", "=", sessionId)
			.where("state", "!=", "settled")
			.execute();
		for (const row of rows) {
			// The stop is not a completion to wake for: its jobs' notices are collected, never pending.
			this.#silenced.add(row.id);
			try {
				await this.cancelJob(row, by ?? { type: "system", id: "jobs", onBehalfOfUserId: row.on_behalf_of_user_id });
			} catch (err) {
				console.error(`jobs: cancelling job ${row.id} of session ${sessionId} failed:`, err);
			}
		}
	}

	async get(id: string): Promise<JobRow | undefined> {
		return this.#db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
	}

	/**
	 * Creates the job for a tool call, or returns the one a replayed call already created. The row is projected
	 * before it is returned, so the starting tool's own render sees the current state.
	 */
	async ensure(input: NewJob): Promise<JobRow> {
		const id = jobId(input.kind, input.callKey);
		const existing = await this.get(id);
		if (existing) return existing;
		const now = new Date().toISOString();
		await this.#db
			.insertInto("jobs")
			.values({
				id,
				org_id: input.orgId ?? (await defaultOrgId(this.#db)),
				actor_type: input.actor.type,
				actor_id: input.actor.id,
				on_behalf_of_user_id: input.actor.onBehalfOfUserId,
				session_id: input.sessionId,
				call_key: input.callKey,
				kind: input.kind,
				resource_type: input.resourceType,
				resource_id: input.resourceId,
				action: JSON.stringify(input.action),
				state: "running",
				outcome: null,
				wait: null,
				result: null,
				notice: "none",
				created_at: now,
				settled_at: null,
			})
			.onConflict((conflict) => conflict.doNothing())
			.execute();
		const row = await this.get(id);
		if (!row) throw new Error("the job row disappeared");
		const projected = (await this.project(row)) ?? row;
		// A new job is a change even when its first projection equals the row just inserted (running, no wait),
		// which the projection writer cannot tell from an unchanged one. A concurrent create that won the
		// conflict may send this change twice; listeners treat it as idempotent.
		if (projected.state === "running" && projected.wait === null && projected.outcome === null) {
			this.#emit(projected);
		}
		return projected;
	}

	/**
	 * Recomputes and stores the job's projection. Serialized per job id: a projection reads the record and writes
	 * the row inside the job's queue slot, so the last write is always computed from data read after the previous
	 * write. `settled_at` is set once.
	 */
	project(job: Pick<JobRow, "id">): Promise<JobRow | undefined> {
		return this.#queue.run(job.id, async () => {
			const current = await this.get(job.id);
			if (!current) return undefined;
			// A settled job never reopens: its outcome, result and notice are final (doc/design/jobs.md "States").
			if (current.state === "settled" || current.settled_at !== null) return current;
			const source = this.#sources.get(current.kind);
			if (!source) return current;
			const projection = await source.project(current);
			// The record is gone: keep the last projection rather than inventing one (retention is a later phase).
			if (!projection) return current;
			const outcome = projection.outcome === null ? null : JSON.stringify(projection.outcome);
			const settledAt = projection.state === "settled" ? new Date().toISOString() : null;
			const unchanged =
				current.state === projection.state && current.outcome === outcome && current.wait === projection.wait;
			if (unchanged) return current;
			const settling = projection.state === "settled";
			const notice = settling ? this.#noticeOnSettle(current) : current.notice;
			const sessionId = current.session_id;
			if (settling && sessionId !== null) this.#settling.set(sessionId, (this.#settling.get(sessionId) ?? 0) + 1);
			try {
				await this.#db
					.updateTable("jobs")
					.set({
						state: projection.state,
						outcome,
						wait: projection.wait,
						settled_at: settledAt,
						...(notice === current.notice ? {} : { notice }),
					})
					.where("id", "=", current.id)
					.execute();
				const updated = (await this.get(current.id)) ?? current;
				this.#emit(updated);
				if (settling) await this.#settled(updated, notice);
				return updated;
			} finally {
				if (settling) {
					if (sessionId !== null) {
						const left = (this.#settling.get(sessionId) ?? 1) - 1;
						if (left <= 0) this.#settling.delete(sessionId);
						else this.#settling.set(sessionId, left);
					}
					this.#notifySettled(sessionId);
				}
			}
		});
	}

	/**
	 * Waits up to `seconds` and returns the job's current row; `null` waits without a deadline (the foreground
	 * `subagent` tool). A job that settles returns at once. `attention` ends a wait only on something this agent
	 * must decide, which only a subagent request is; exec approvals and call approvals are the user's. In an agent
	 * session the exec adapter uses the tool layer's wait through approval and signature (the same
	 * `waitBackgroundTask` the exec tool uses), bounded by `wait` and given the caller's context.
	 *
	 * One adapter wait is not always enough: a subagent's run can end while its child still owns background jobs
	 * (or a notice that will wake it), so the job stays running after its record's own wait returned. The wait then
	 * blocks on the child's and the owner's job changes until the job settles or the deadline passes, instead of
	 * returning "still running" immediately (doc/design/jobs.md "States").
	 */
	async waitJob(job: JobRow, seconds: number | null, options: JobWaitOptions): Promise<JobRow | undefined> {
		let current = await this.project(job);
		if (!current) return current;
		// Reading a settled job is collecting its notice, and withdrawing one not yet delivered
		// (doc/design/jobs.md "Completion notices").
		if (current.state === "settled") {
			await this.collect(current.id);
			return this.get(current.id);
		}
		const left = seconds === null ? null : Math.max(0, seconds) * 1000;
		const deadline = left === null ? Number.POSITIVE_INFINITY : Date.now() + left;
		if (options.signal?.aborted) return current;
		const source = this.#sources.get(current.kind);
		if (!source) return current;
		// `left` may be 0: each adapter ends its own wait at its own deadline. An exec wait honours `wait`
		// through approval and signature (the tool layer's `waitBackgroundTask`), so a zero budget returns a
		// waiting task at once.
		const release = this.beginWait(current.id);
		try {
			for (;;) {
				if (options.signal?.aborted) return current;
				// Snapshot the change counters before waiting: a change during the wait must not be missed.
				const watched = this.#watchedSessions(current);
				const remaining = deadline === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : deadline - Date.now();
				await source.wait(current, Math.max(0, remaining), {
					...options,
					attention: current.kind === "subagent" && options.attention,
				});
				const projected = await this.project(current);
				if (!projected) return undefined;
				current = projected;
				if (current.state === "settled") {
					await this.collect(current.id);
					return this.get(current.id);
				}
				// A subagent request this agent must decide (an approval routed to it, or a quota grant) ends the
				// wait even though the job is not settled.
				if (
					current.kind === "subagent" &&
					options.attention &&
					current.state === "waiting" &&
					(current.wait === "decision" || current.wait === "quota")
				) {
					return current;
				}
				const rest = deadline === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : deadline - Date.now();
				if (rest <= 0) return current;
				// Only a subagent job can still be running after its record's own wait returned: its child owns
				// unsettled work or a notice that will wake it. Other kinds' adapters wait to their own deadline.
				if (current.kind !== "subagent") return current;
				await this.#waitForAnyChange(watched, rest, options.signal);
				current = (await this.project(current)) ?? current;
				if (current.state === "settled") {
					await this.collect(current.id);
					return this.get(current.id);
				}
			}
		} finally {
			release();
		}
	}

	/** The sessions whose job changes can move this job: a subagent's child and every job's owner. */
	#watchedSessions(job: JobRow): Map<string, number> {
		const watched = new Map<string, number>();
		const ids = job.kind === "subagent" ? [job.resource_id, job.session_id] : [job.session_id];
		for (const id of ids) {
			if (id !== null) watched.set(id, this.#settleSeq.get(id) ?? 0);
		}
		return watched;
	}

	/** Blocks until one of the watched sessions changes or the deadline passes; no polling. */
	#waitForAnyChange(watched: Map<string, number>, ms: number, signal?: AbortSignal): Promise<void> {
		if (watched.size === 0) {
			return new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.max(0, ms));
				timer.unref?.();
			});
		}
		if (signal?.aborted) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const controller = new AbortController();
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				controller.abort();
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", finish);
				resolve();
			};
			const timer =
				Number.isFinite(ms) && ms < Number.POSITIVE_INFINITY ? setTimeout(finish, Math.max(0, ms)) : undefined;
			timer?.unref?.();
			signal?.addEventListener("abort", finish, { once: true });
			void Promise.race(
				[...watched].map(([sessionId, seq]) => this.#waitForChange(sessionId, seq, controller.signal)),
			).then(finish);
		});
	}

	/** Cancels through the record's own path and returns the projection after the cancel. */
	async cancelJob(job: JobRow, by: Actor): Promise<{ job: JobRow | undefined; cancelled: boolean }> {
		if (job.state === "settled") return { job, cancelled: false };
		const source = this.#sources.get(job.kind);
		const cancelled = source ? await source.cancel(job, by) : false;
		return { job: await this.project(job), cancelled };
	}

	async render(job: JobRow, ctx: ToolContext): Promise<ToolResult> {
		const source = this.#sources.get(job.kind);
		if (!source) return errorResult("text", "no_such_job", "the job's kind is unknown");
		const result = await source.render(job, ctx);
		// A tool result's details carry the job id for the WebUI, like the starting tool's own result did.
		return { ...result, details: { ...(result.details ?? {}), job_id: job.id } };
	}

	/** This caller's jobs, newest first: a session's own, or the jobs an API token started. */
	async list(actor: Actor, state?: JobState): Promise<JobRow[]> {
		let query = this.#db.selectFrom("jobs").selectAll();
		if (actor.type === "api_token") {
			query = query.where("actor_type", "=", "api_token").where("actor_id", "=", actor.id);
		} else if (actor.type === "session" || actor.type === "subagent") {
			query = query.where("session_id", "=", actor.id);
		} else {
			return [];
		}
		if (state !== undefined) query = query.where("state", "=", state);
		return query.orderBy("created_at", "desc").orderBy("id", "desc").execute();
	}

	/** Stores the rendered result of a call, then projects its job (doc/design/jobs.md "Results"). */
	async callResult(callKey: string, result: ToolResult): Promise<void> {
		const row = await this.get(jobId("call", callKey));
		if (!row) return;
		if (row.result === null) {
			await this.#db
				.updateTable("jobs")
				.set({ result: serializeCallResult(result) })
				.where("id", "=", row.id)
				.execute();
		}
		await this.project(row);
	}

	/** Projects a call's job after its row changed state (created, approved or finished). */
	async callChanged(callKey: string): Promise<void> {
		const row = await this.get(jobId("call", callKey));
		if (row) await this.project(row);
	}

	/** Recomputes a task's job after the Cluster notified a change. */
	changed(resourceType: JobRow["resource_type"], resourceId: string): void {
		this.#background("projecting after a record change", this.#projectResource(resourceType, resourceId));
	}

	/** Recomputes the subagent job watching a child whose stored state changed. */
	sessionChanged(sessionId: string): void {
		// A wait on that child's `subagent` job wakes on any of its changes, not only on a settle.
		this.#notifySettled(sessionId);
		this.#background("projecting a subagent job", this.#projectResource("session", sessionId));
	}

	/**
	 * Startup reconciliation (doc/design/jobs.md "Job model"): every unsettled job is projected once after durable
	 * resumed the runs and before requests are served. One failure is logged and does not stop the others.
	 */
	async reconcile(): Promise<void> {
		const rows = await this.#db.selectFrom("jobs").selectAll().where("state", "!=", "settled").execute();
		for (const row of rows) {
			try {
				await this.project(row);
			} catch (err) {
				console.error(`jobs: reconciling job ${row.id} failed:`, err);
			}
		}
	}

	/**
	 * Waits until the record-change projections and the queued projection writes have settled, so nothing writes a
	 * job after the database is destroyed. Shutdown awaits this before closing the database (main.ts,
	 * AgentRuntime.close).
	 */
	async drain(): Promise<void> {
		for (;;) {
			const pending = [...this.#pending, ...this.#queue.pending];
			if (pending.length === 0) return;
			await Promise.all(pending);
			if (this.#pending.size === 0 && this.#queue.size === 0) return;
		}
	}

	/**
	 * Tracks a projection started by a record change: it is awaited by drain() and a failure is logged instead of
	 * becoming an unhandled rejection. No failure is expected at shutdown once drain() has run.
	 */
	#background(what: string, work: Promise<unknown>): void {
		const tracked: Promise<void> = work
			.catch((err: unknown) => console.error(`jobs: ${what} failed:`, err))
			.then(() => {
				this.#pending.delete(tracked);
			});
		this.#pending.add(tracked);
	}

	/** Tells every listener that the job's projection changed; one listener's failure never stops the others. */
	#emit(job: JobRow): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener(job);
			} catch (err) {
				console.error(`jobs: a change listener failed for ${job.id}:`, err);
			}
		}
	}

	async #projectResource(resourceType: JobRow["resource_type"], resourceId: string): Promise<void> {
		const rows = await this.#db
			.selectFrom("jobs")
			.select("id")
			.where("resource_type", "=", resourceType)
			.where("resource_id", "=", resourceId)
			.where("state", "!=", "settled")
			.execute();
		for (const row of rows) await this.project(row);
	}

	/** What a settling job's notice becomes (doc/design/jobs.md "Completion notices"): none for an MCP client. */
	#noticeOnSettle(job: JobRow): JobRow["notice"] {
		if (job.session_id === null) return "none";
		// Silenced before the settle (a stop or a deletion), also by a previous process: never wake for it.
		if (job.notice === "collected") {
			this.#silenced.delete(job.id);
			return "collected";
		}
		if (this.#silenced.delete(job.id)) return "collected";
		if ((this.#waiting.get(job.id) ?? 0) > 0) return "collected";
		return "pending";
	}

	/**
	 * A job that settled may be what kept its subagent owner unsettled: project the `subagent` jobs watching that
	 * child (doc/design/jobs.md "States"). In the background, so a settled job's own write is not delayed by it.
	 * The completion notice is delivered now, and awaited: a session waiting to become final must not look
	 * settled before its wake was submitted.
	 */
	async #settled(job: JobRow, notice: JobRow["notice"]): Promise<void> {
		if (job.actor_type === "subagent") {
			this.#background("projecting a settled child's job", this.#projectResource("session", job.actor_id));
		}
		if (notice !== "pending" || job.session_id === null) return;
		try {
			await this.#noticeSink?.(job);
		} catch (err) {
			console.error(`jobs: delivering the completion notice of ${job.id} failed:`, err);
		}
	}

	/** Wakes the waiters of a session's quiet state (a settle, a notice delivery or a collect). */
	#notifySettled(sessionId: string | null): void {
		if (sessionId === null) return;
		this.#settleSeq.set(sessionId, (this.#settleSeq.get(sessionId) ?? 0) + 1);
		const waiters = this.#settleWaiters.get(sessionId);
		if (!waiters) {
			// Nobody needs the counter, so a session's entry does not outlive its waiters (a session is otherwise
			// remembered forever by a single settle).
			this.#settleSeq.delete(sessionId);
			return;
		}
		for (const wake of [...waiters]) wake();
		if (waiters.size === 0 && this.#settleWaiters.get(sessionId) === waiters) {
			this.#settleWaiters.delete(sessionId);
			this.#settleSeq.delete(sessionId);
		}
	}

	/** Waits for the next change of the session's jobs, without polling; a change since `seq` returns at once. */
	#waitForChange(sessionId: string, seq: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			const finish = () => {
				signal?.removeEventListener("abort", finish);
				resolve();
			};
			if (signal?.aborted || (this.#settleSeq.get(sessionId) ?? 0) !== seq) {
				finish();
				return;
			}
			const waiters = this.#settleWaiters.get(sessionId) ?? new Set<() => void>();
			this.#settleWaiters.set(sessionId, waiters);
			const wake = () => {
				waiters.delete(wake);
				if (waiters.size === 0 && this.#settleWaiters.get(sessionId) === waiters) {
					this.#settleWaiters.delete(sessionId);
				}
				finish();
			};
			waiters.add(wake);
			signal?.addEventListener("abort", wake, { once: true });
		});
	}
}

/** Creates the service and wires the record-change hooks (one instance per process). */
export function createJobs(options: JobsOptions): Jobs {
	return new Jobs(options);
}

/** A job's outcome as stored; undefined before it settled or when the column cannot be read. */
export function outcomeOf(job: Pick<JobRow, "outcome">): TaskOutcome | undefined {
	if (!job.outcome) return undefined;
	try {
		return JSON.parse(job.outcome) as TaskOutcome;
	} catch {
		return undefined;
	}
}
