import type { ExpressionBuilder } from "kysely";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { Audit, AuditActor } from "../audit/audit.ts";
import { userActor } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { Database } from "../storage/schema.ts";
import { errorText, isUniqueViolation, NotFoundError, UserError } from "../util/errors.ts";
import { derivedId, newId } from "../util/id.ts";
import { KeyedQueue } from "../util/keyed-queue.ts";
import {
	deleteSchedule as deleteStoredSchedule,
	disableSchedulesOfOwner,
	getRun,
	getSchedule,
	lastRunAtOrBefore,
	listRuns,
	MISSED_TOLERANCE_MS,
	NeverFiresError,
	nextRunAfter,
	type Schedule,
	type ScheduleRun,
	scheduleActor,
} from "./store.ts";

/**
 * The scheduler (doc/design/scheduling.md): a loop that wakes at the earliest `next_run_at` (at most every 60 s, and
 * at once when a schedule changes), writes a pending run per due trigger in one transaction, then a submitter
 * that preempts the previous instance and creates + submits a new session. Firing and submitting are separate
 * so a crash between them loses nothing (pending runs are submitted on start, and the derived session id and
 * request id make a retried submit idempotent).
 *
 * The clock and the timer are injectable so tests drive time instead of sleeping.
 */

/** Longest the loop sleeps; wakes sooner when the next run is closer (doc/design/scheduling.md "Triggering and submission"). */
export const MAX_SLEEP_MS = 60_000;

/** Backoff after a failed trigger; doubles per consecutive failure of the same schedule (doc/design/scheduling.md "Triggering and submission"). */
export const FAILURE_BACKOFF_MS = 60_000;

/** The backoff never grows past this. */
export const MAX_FAILURE_BACKOFF_MS = 60 * 60_000;

/** A run just written, and whether it was the schedule's last trigger (its cron never fires again). */
interface InsertedRun {
	run: ScheduleRun;
	lastTrigger: boolean;
}

export interface SchedulerOptions {
	db: Db;
	runtime: AgentRuntime;
	audit?: Audit;
	/** Injectable clock (tests advance it); defaults to the real one. */
	now?: () => Date;
	/** Injectable timer: schedules `fn` after `ms` and returns a cancel function. */
	setTimer?: (fn: () => void, ms: number) => () => void;
}

function defaultTimer(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	return () => clearTimeout(timer);
}

/** Why a submission that did not finish normally counts as failed (doc/design/scheduling.md "Triggering and submission"). */
function failureReason(reason: string): string {
	switch (reason) {
		case "aborted":
			return "aborted";
		case "model_error":
			return "the model request failed";
		case "no_model":
			return "no model is configured";
		case "faulted":
			return "the run failed";
		case "stale":
		case "reset":
			return "the run was superseded";
		case "missing":
			return "the submission is gone";
		default:
			return reason;
	}
}

export class Scheduler {
	readonly #db: Db;
	readonly #runtime: AgentRuntime;
	readonly #audit: Audit | undefined;
	readonly #now: () => Date;
	readonly #setTimer: (fn: () => void, ms: number) => () => void;
	#started = false;
	#stopping = false;
	#timer: (() => void) | undefined;
	/** Bumped on every arm, so a slow delay calculation cannot overwrite a newer one. */
	#armGeneration = 0;
	#ticking: Promise<void> | undefined;
	#again = false;
	/** Runs already being submitted by this process; the derived id makes a retried submit harmless anyway. */
	#submitting = new Set<string>();
	/**
	 * Serializes a schedule's removal with its submission. A submit checks the schedule's existence and creates
	 * its session inside this turn, so a removal cannot delete the schedule between that check and the insert; the
	 * removal then stops the run the submit created instead of leaving an unlinked, inheriting session behind.
	 */
	#scheduleQueue = new KeyedQueue("schedule queue");
	#watchers = new Set<Promise<void>>();
	/** Aborts in-flight run watchers on stop; recreated so a stopped scheduler can be started again. */
	#lifecycle = new AbortController();
	/** The owner's deny while a scheduled run waits for its root quota; the next finish reads and clears it. */
	#quotaDenied = new Map<string, string>();
	/** Consecutive failed triggers per schedule id; a successful pass resets the count (doc/design/scheduling.md "Triggering and submission"). */
	#failures = new Map<string, number>();

	constructor(options: SchedulerOptions) {
		this.#db = options.db;
		this.#runtime = options.runtime;
		this.#audit = options.audit;
		this.#now = options.now ?? (() => new Date());
		this.#setTimer = options.setTimer ?? defaultTimer;
	}

	get running(): boolean {
		return this.#started && !this.#stopping;
	}

	/** The clock the scheduler, and the schedule API it backs, reason about "now" with. */
	now(): Date {
		return this.#now();
	}

	/** Submits leftover pending runs, reconciles finished ones, then starts the loop (doc/design/scheduling.md "Triggering and submission"). */
	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#stopping = false;
		this.#lifecycle = new AbortController();
		await this.#recover();
		await this.#enqueuePass();
		await this.#arm();
	}

	/** Stops the loop and waits for an in-flight tick and every run watcher, before the runtime is closed. */
	async stop(): Promise<void> {
		if (!this.#started || this.#stopping) return;
		this.#stopping = true;
		this.#timer?.();
		this.#timer = undefined;
		this.#lifecycle.abort();
		await this.#ticking;
		await Promise.allSettled([...this.#watchers]);
		this.#started = false;
	}

	/** Wakes the loop: a schedule was created, changed or run by hand, or an owner signed in again. */
	wake(): void {
		if (!this.#started || this.#stopping) return;
		if (this.#ticking) {
			this.#again = true;
			return;
		}
		void this.#arm(0);
	}

	/** One pass of the loop: fire what is due, then submit everything pending. Tests call this directly. */
	async tick(): Promise<void> {
		await this.#fireDue();
		await this.#submitPending();
	}

	/** `POST /api/schedules/:id/run`: the same path as a trigger, with `manual = true` and the user as actor. */
	async runNow(scheduleId: string, user: SessionUser): Promise<ScheduleRun> {
		const schedule = await getSchedule(this.#db, scheduleId);
		if (!schedule) throw new NotFoundError("no such schedule");
		const owner = await this.#ownerUser(schedule.ownerUserId);
		if (!owner) throw new UserError("the schedule's owner is disabled");
		const fired = await this.#insertRun(schedule, this.#now(), true);
		if (fired) {
			await this.#record(userActor(user), "schedule.fired", schedule, {
				run_id: fired.run.id,
				fire_time: fired.run.fireTime,
				manual: true,
			});
			// The same line as the loop: a manual run never submits alongside a timed pass (doc/design/scheduling.md).
			// After a stop it is left pending for the next start's recovery instead of failing on a closed runtime.
			if (!this.#stopping) {
				await this.#enqueuePass();
				if (this.#again && !this.#stopping) {
					this.#again = false;
					void this.#arm(0);
				}
			}
			return (await getRun(this.#db, fired.run.id)) ?? fired.run;
		}
		// A manual click in the same millisecond as the previous one lands on the same fire time.
		const existing = await listRuns(this.#db, scheduleId, 1);
		const run1 = existing[0];
		if (!run1) throw new UserError("the run was not created");
		return run1;
	}

	/**
	 * Deletes a schedule (doc/design/scheduling.md "Lifecycle"): stop the running instance with the session's normal stop
	 * path, then remove the schedule, its runs and the sessions' link (`DELETE /api/schedules/:id`).
	 *
	 * The removal runs in the schedule's queue turn, so a submit that already claimed a run finishes first: its
	 * session exists by the time the stop runs, and the deletion cannot race the session's insert.
	 */
	async remove(scheduleId: string): Promise<void> {
		const schedule = await getSchedule(this.#db, scheduleId);
		if (!schedule) throw new NotFoundError("no such schedule");
		await this.#scheduleQueue.run(scheduleId, async () => {
			// Includes claimed runs: a submit that got as far as `started_at` is serialized before this turn, so
			// its session is visible to #stopRunning now. A claimed run left by a crash has no session and is
			// deleted with the rest.
			await this.#stopRunning(schedule);
			const sessions = await deleteStoredSchedule(this.#db, schedule);
			this.#failures.delete(scheduleId);
			// The sessions lost their schedule link, which the list shows; publish the new items.
			for (const sessionId of sessions) this.#runtime.sessionList.publishSession(sessionId);
		});
	}

	async #stopRunning(schedule: Schedule): Promise<void> {
		const rows = await this.#db
			.selectFrom("schedule_runs")
			.select("session_id")
			.where("schedule_id", "=", schedule.id)
			.where("status", "in", ["pending", "running"])
			.execute();
		for (const row of rows) {
			if (!row.session_id) continue;
			try {
				await this.#runtime.abort(row.session_id);
			} catch (err) {
				console.error(`scheduler: stopping session ${row.session_id} of a deleted schedule failed:`, err);
			}
		}
	}

	/**
	 * The owner denied a scheduled run's root quota, so the run ends `failed` instead of `succeeded`. Called
	 * before the deny wakes the paused call, so the outcome is known when the submission settles.
	 */
	async noteQuotaDenied(sessionId: string, reason: string): Promise<void> {
		const session = await this.#db
			.selectFrom("sessions")
			.select("schedule_id")
			.where("id", "=", sessionId)
			.executeTakeFirst();
		if (!session?.schedule_id) return;
		// Only a run that is still going can end failed because of this deny.
		const running = await this.#db
			.selectFrom("schedule_runs")
			.select("id")
			.where("session_id", "=", sessionId)
			.where("status", "=", "running")
			.limit(1)
			.executeTakeFirst();
		if (running) this.#quotaDenied.set(sessionId, reason);
	}

	/** Drops a note whose decision did not happen, so a later normal finish is not marked failed. */
	clearQuotaDenied(sessionId: string): void {
		this.#quotaDenied.delete(sessionId);
	}

	// ---- the loop ----

	async #runTick(): Promise<void> {
		if (this.#stopping) return;
		await this.#enqueuePass();
		if (this.#again && !this.#stopping) {
			this.#again = false;
			await this.#runTick();
			return;
		}
		await this.#arm();
	}

	/**
	 * Queues one pass behind any in-flight one. The timer, `start` and a manual run all go through here, so two
	 * passes never claim and submit runs at the same time (doc/design/scheduling.md "One instance at a time"). The returned
	 * promise is what `stop()` awaits, so a pass started by runNow is not cut off by the runtime closing.
	 */
	#enqueuePass(): Promise<void> {
		const previous = this.#ticking ?? Promise.resolve();
		const pass = previous
			.then(() => (this.#stopping ? undefined : this.tick()))
			.catch((err: unknown) => console.error("scheduler: a pass failed:", err));
		const tail = pass.finally(() => {
			if (this.#ticking === tail) this.#ticking = undefined;
		});
		this.#ticking = tail;
		return tail;
	}

	/** Arms the next wake-up (or sets it to `ms`); awaited so a started loop has its timer before it returns. */
	async #arm(ms?: number): Promise<void> {
		const generation = ++this.#armGeneration;
		this.#timer?.();
		this.#timer = undefined;
		if (!this.#started || this.#stopping) return;
		let delay: number;
		if (ms !== undefined) delay = ms;
		else {
			try {
				delay = await this.#delayUntilNextRun();
			} catch (err) {
				console.error("scheduler: computing the next wake failed:", err);
				delay = MAX_SLEEP_MS;
			}
		}
		if (generation !== this.#armGeneration || !this.#started || this.#stopping) return;
		this.#timer = this.#setTimer(() => {
			this.#timer = undefined;
			void this.#runTick();
		}, delay);
	}

	async #delayUntilNextRun(): Promise<number> {
		const row = await this.#db
			.selectFrom("schedules")
			.select("next_run_at")
			.where("enabled", "=", 1)
			.where("next_run_at", "is not", null)
			.orderBy("next_run_at")
			.limit(1)
			.executeTakeFirst();
		if (!row?.next_run_at) return MAX_SLEEP_MS;
		const delay = Date.parse(row.next_run_at) - this.#now().getTime();
		return Math.max(0, Math.min(MAX_SLEEP_MS, delay));
	}

	/** Writes a pending run for every enabled schedule that is due (doc/design/scheduling.md "Triggering and submission"). */
	async #fireDue(): Promise<void> {
		const now = this.#now();
		const rows = await this.#db
			.selectFrom("schedules")
			.selectAll()
			.where("enabled", "=", 1)
			.where("next_run_at", "is not", null)
			.where("next_run_at", "<=", now.toISOString())
			.orderBy("next_run_at")
			.execute();
		for (const row of rows) {
			const schedule = (await getSchedule(this.#db, row.id)) ?? null;
			if (!schedule) continue;
			if (!schedule.enabled) {
				// Disabled between the query and this read: the trigger did not fire (doc/design/scheduling.md "Audit").
				await this.#skip(schedule, { fire_time: row.next_run_at, reason: "disabled" });
				this.#failures.delete(schedule.id);
				continue;
			}
			if (!schedule.nextRunAt) continue;
			try {
				await this.#fireOne(schedule, now);
				this.#failures.delete(schedule.id);
			} catch (err) {
				console.error(`scheduler: firing schedule ${schedule.id} failed:`, err);
				await this.#backOff(schedule, err, now).catch((backoffError: unknown) => {
					console.error(`scheduler: backing off schedule ${schedule.id} failed:`, backoffError);
				});
			}
		}
	}

	/**
	 * Ends a trigger that could not fire (doc/design/scheduling.md "Triggering and submission"). A cron with no further fire time never runs
	 * again, so its schedule is disabled; any other failure moves `next_run_at` out by a doubling backoff
	 * (1 minute, then 2, 4, …, capped at an hour), so the loop does not spin on a trigger that keeps failing.
	 */
	async #backOff(schedule: Schedule, err: unknown, now: Date): Promise<void> {
		if (err instanceof NeverFiresError) {
			await this.#disableNeverFires(schedule, now);
			return;
		}
		const failures = (this.#failures.get(schedule.id) ?? 0) + 1;
		this.#failures.set(schedule.id, failures);
		const delay = Math.min(FAILURE_BACKOFF_MS * 2 ** (failures - 1), MAX_FAILURE_BACKOFF_MS);
		await this.#db
			.updateTable("schedules")
			.set({ next_run_at: new Date(now.getTime() + delay).toISOString(), updated_at: now.toISOString() })
			.where("id", "=", schedule.id)
			// A concurrent edit already chose another next time; keep it.
			.where("next_run_at", "=", schedule.nextRunAt as string)
			.execute();
	}

	/**
	 * Disables a schedule whose cron will never fire again and audits it. Conditional on the next time the
	 * failed trigger was for, so a concurrent edit with a cron that does fire is left alone.
	 */
	async #disableNeverFires(schedule: Schedule, now: Date): Promise<void> {
		const res = await this.#db
			.updateTable("schedules")
			.set({ enabled: 0, next_run_at: null, updated_at: now.toISOString() })
			.where("id", "=", schedule.id)
			.where("next_run_at", "=", schedule.nextRunAt as string)
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return;
		this.#failures.delete(schedule.id);
		await this.#record(scheduleActor(schedule), "schedule.disabled", schedule, { reason: "never_fires" });
	}

	async #fireOne(schedule: Schedule, now: Date): Promise<void> {
		const owner = await this.#ownerUser(schedule.ownerUserId);
		if (!owner) {
			// The lifecycle hook disables a disabled owner's schedules; this covers a race or a direct edit.
			await this.#skip(schedule, { fire_time: schedule.nextRunAt, reason: "owner_disabled" });
			await this.#db
				.updateTable("schedules")
				.set({ enabled: 0, next_run_at: null, updated_at: now.toISOString() })
				.where("id", "=", schedule.id)
				.execute();
			return;
		}
		const due = new Date(schedule.nextRunAt as string);
		const late = now.getTime() - due.getTime();
		if (late > MISSED_TOLERANCE_MS) {
			// Downtime or a clock jump: skip, or run only the most recent missed time (doc/design/scheduling.md "Triggering and submission").
			if (!schedule.catchUp) {
				await this.#skip(schedule, { fire_time: due.toISOString(), reason: "missed" });
				await this.#advance(
					schedule,
					schedule.nextRunAt as string,
					nextRunAfter(schedule.cron, schedule.timezone, now),
					now,
				);
				return;
			}
			const latest = lastRunAtOrBefore(schedule.cron, schedule.timezone, now) ?? due;
			await this.#fireAt(schedule, latest, false, scheduleActor(schedule), now, schedule.nextRunAt as string);
			return;
		}
		await this.#fireAt(schedule, due, false, scheduleActor(schedule), due, schedule.nextRunAt as string);
	}

	/**
	 * Inserts the run and advances `next_run_at` in one transaction; the conditional update keeps a concurrent
	 * edit (or another instance) from firing a time that is no longer the schedule's next one.
	 */
	async #fireAt(
		schedule: Schedule,
		fireTime: Date,
		manual: boolean,
		actor: AuditActor,
		nextFrom: Date,
		expectedNext: string,
	): Promise<void> {
		const fired = await this.#insertRun(schedule, fireTime, manual, nextFrom, expectedNext);
		if (!fired) return;
		await this.#record(actor, "schedule.fired", schedule, {
			run_id: fired.run.id,
			fire_time: fired.run.fireTime,
			manual,
		});
		if (fired.lastTrigger)
			await this.#record(scheduleActor(schedule), "schedule.disabled", schedule, { reason: "never_fires" });
	}

	/** Inserts a pending run (and the schedule's next time, unless manual); undefined when it already exists. */
	async #insertRun(
		schedule: Schedule,
		fireTime: Date,
		manual: boolean,
		nextFrom?: Date,
		expectedNext?: string,
	): Promise<InsertedRun | undefined> {
		const id = newId();
		const now = this.#now().toISOString();
		let lastTrigger = false;
		try {
			const created = await this.#db.transaction().execute(async (trx) => {
				if (!manual) {
					let next: string | null;
					try {
						next = nextRunAfter(schedule.cron, schedule.timezone, nextFrom ?? fireTime);
					} catch (err) {
						if (!(err instanceof NeverFiresError)) throw err;
						// This trigger is the last one: fire it, then disable the schedule in the same transaction.
						next = null;
						lastTrigger = true;
					}
					let update = trx
						.updateTable("schedules")
						.set(
							lastTrigger ? { enabled: 0, next_run_at: null, updated_at: now } : { next_run_at: next, updated_at: now },
						)
						.where("id", "=", schedule.id);
					if (expectedNext !== undefined) update = update.where("next_run_at", "=", expectedNext);
					const res = await update.executeTakeFirst();
					if (res.numUpdatedRows === 0n) return false;
				}
				await trx
					.insertInto("schedule_runs")
					.values({
						id,
						schedule_id: schedule.id,
						fire_time: fireTime.toISOString(),
						manual: manual ? 1 : 0,
						status: "pending",
						session_id: null,
						reason: null,
						created_at: now,
						started_at: null,
						finished_at: null,
					})
					.execute();
				return true;
			});
			if (!created) return undefined;
		} catch (err) {
			if (isUniqueViolation(err)) {
				// A run for this trigger is already written. The transaction rolled the next time back too; advance
				// it, or the loop retries this trigger forever. If the cron has no fire time left, the existing run
				// is the schedule's last one: disable it instead of writing a second one.
				if (!manual && nextFrom !== undefined && expectedNext !== undefined) {
					try {
						await this.#advance(
							schedule,
							expectedNext,
							nextRunAfter(schedule.cron, schedule.timezone, nextFrom),
							this.#now(),
						);
					} catch (advanceError) {
						if (!(advanceError instanceof NeverFiresError)) throw advanceError;
						await this.#disableNeverFires(schedule, this.#now());
					}
				}
				return undefined;
			}
			throw err;
		}
		const run = await getRun(this.#db, id);
		return run ? { run, lastTrigger } : undefined;
	}

	/** Moves `next_run_at` forward without firing (a skipped trigger). */
	async #advance(schedule: Schedule, expectedNext: string, next: string, now: Date): Promise<void> {
		await this.#db
			.updateTable("schedules")
			.set({ next_run_at: next, updated_at: now.toISOString() })
			.where("id", "=", schedule.id)
			.where("next_run_at", "=", expectedNext)
			.execute();
	}

	async #skip(schedule: Schedule, detail: Record<string, unknown>): Promise<void> {
		await this.#record(scheduleActor(schedule), "schedule.skipped", schedule, detail);
	}

	/** Claims and submits every pending run, oldest trigger first (doc/design/scheduling.md "Triggering and submission"). */
	async #submitPending(): Promise<void> {
		const rows = await this.#db
			.selectFrom("schedule_runs")
			.selectAll()
			.where("status", "=", "pending")
			.orderBy("fire_time")
			.orderBy("id")
			.execute();
		for (const row of rows) {
			if (this.#stopping) return;
			if (this.#submitting.has(row.id)) continue;
			this.#submitting.add(row.id);
			try {
				await this.#submitRun(row.id);
			} catch (err) {
				console.error(`scheduler: submitting run ${row.id} failed:`, err);
				await this.#failRun(row.id, errorText(err)).catch(() => {});
			} finally {
				this.#submitting.delete(row.id);
			}
		}
	}

	async #submitRun(runId: string): Promise<void> {
		const run = await getRun(this.#db, runId);
		if (run?.status !== "pending") return;
		await this.#scheduleQueue.run(run.scheduleId, async () => {
			// A removal may have deleted the run while this turn waited for the schedule's queue.
			const current = await getRun(this.#db, runId);
			if (current?.status !== "pending") return;
			// The claim is `started_at`, not the status: the run stays `pending` until its session is submitted, and
			// preemption must still count it as an instance (doc/design/scheduling.md "One instance at a time"). A claimed run left by
			// a crash is claimed again here; the derived session id and request id make the resubmit harmless.
			const claimed = await this.#db
				.updateTable("schedule_runs")
				.set({ started_at: this.#now().toISOString() })
				.where("id", "=", runId)
				.where("status", "=", "pending")
				.executeTakeFirst();
			if (claimed.numUpdatedRows === 0n) return;
			// Re-check the schedule inside the serialization, before the session exists: a removal that ran first
			// deleted the run above, and one that runs later waits for this turn and stops the session it creates.
			const schedule = await getSchedule(this.#db, current.scheduleId);
			if (!schedule) return;
			const owner = await this.#ownerUser(schedule.ownerUserId);
			if (!owner) {
				await this.#fail(schedule, current.id, "the schedule's owner is disabled");
				return;
			}
			// One instance at a time: the previous run is stopped before the new session exists (doc/design/scheduling.md).
			await this.#preemptPrevious(schedule, current.id);
			const sessionId = derivedId(`schedule-run:${current.id}`);
			let submissionId: string;
			try {
				await this.#runtime.createScheduledSession(owner, {
					id: sessionId,
					title: schedule.name,
					model: schedule.model,
					budgetRemaining: schedule.tokenBudget,
					scheduleId: schedule.id,
				});
				submissionId = await this.#runtime.submitAsSchedule(
					sessionId,
					schedule.id,
					schedule.prompt,
					this.#requestId(schedule.id, current.fireTime),
				);
			} catch (err) {
				await this.#fail(schedule, current.id, errorText(err), sessionId);
				return;
			}
			const res = await this.#db
				.updateTable("schedule_runs")
				.set({ status: "running", session_id: sessionId, started_at: this.#now().toISOString() })
				.where("id", "=", current.id)
				.where("status", "=", "pending")
				.executeTakeFirst();
			if (res.numUpdatedRows === 0n) return;
			await this.#record(scheduleActor(schedule), "schedule.run_started", schedule, {
				run_id: current.id,
				session_id: sessionId,
			});
			this.#watchRun(current.id, sessionId, submissionId);
		});
	}

	/** Stops the schedule's other running runs and marks them `preempted` (doc/design/scheduling.md "One instance at a time"). */
	async #preemptPrevious(schedule: Schedule, currentRunId: string): Promise<void> {
		// A run being submitted is claimed (`started_at`) but still `pending`; it is an instance already, so it
		// is stopped too or two instances run side by side.
		const live = (eb: ExpressionBuilder<Database, "schedule_runs">) =>
			eb.or([eb("status", "=", "running"), eb.and([eb("status", "=", "pending"), eb("started_at", "is not", null)])]);
		const running = await this.#db
			.selectFrom("schedule_runs")
			.selectAll()
			.where("schedule_id", "=", schedule.id)
			.where(live)
			.execute();
		for (const row of running) {
			if (row.id === currentRunId) continue;
			const res = await this.#db
				.updateTable("schedule_runs")
				.set({
					status: "preempted",
					reason: "preempted by the next run",
					finished_at: this.#now().toISOString(),
				})
				.where("id", "=", row.id)
				.where(live)
				.executeTakeFirst();
			if (res.numUpdatedRows === 0n) continue;
			await this.#record(scheduleActor(schedule), "schedule.run_preempted", schedule, {
				run_id: row.id,
				session_id: row.session_id,
			});
			if (!row.session_id) continue;
			// The session's normal stop path: cancel its tasks and subagent tree (doc/design/scheduling.md).
			try {
				await this.#runtime.abort(row.session_id);
			} catch (err) {
				console.error(`scheduler: stopping preempted session ${row.session_id} failed:`, err);
			}
		}
		// A run is `succeeded` when its root submission ends, but a background subagent it started can keep
		// running. That work belongs to the previous instance, so the next trigger stops it too; the run's
		// status stays as it was (doc/design/scheduling.md "One instance at a time"). One query joins the schedule's finished
		// runs with their session trees and keeps only a tree that still has a `running` / `awaiting` session
		// (`schedule_runs` is never pruned, so per-run queries would grow without bound); an idle leftover
		// costs no abort, and an already stopped one is not aborted again. The second join branch covers a
		// root whose `root_session_id` was never backfilled.
		const previous = await this.#db
			.selectFrom("schedule_runs as r")
			.innerJoin("sessions as s", (join) =>
				join.on((eb) =>
					eb.or([
						eb("s.root_session_id", "=", eb.ref("r.session_id")),
						eb.and([eb("s.id", "=", eb.ref("r.session_id")), eb("s.root_session_id", "is", null)]),
					]),
				),
			)
			.select(["r.id", "r.session_id"])
			.distinct()
			.where("r.schedule_id", "=", schedule.id)
			.where("r.id", "!=", currentRunId)
			.where("r.status", "in", ["succeeded", "failed", "preempted"])
			.where("s.state", "!=", "idle")
			.execute();
		for (const run of previous) {
			const sessionId = run.session_id;
			if (!sessionId) continue;
			try {
				await this.#runtime.abort(sessionId);
			} catch (err) {
				console.error(`scheduler: stopping leftover work of run ${run.id} (${sessionId}) failed:`, err);
				continue;
			}
			await this.#record(scheduleActor(schedule), "schedule.leftover_stopped", schedule, {
				run_id: run.id,
				session_id: sessionId,
			});
		}
	}

	/** Watches one run's submission; settles the run when it ends. Never polls. */
	#watchRun(runId: string, sessionId: string, submissionId: string): void {
		const watch = (async () => {
			try {
				const outcome = await this.#runtime.waitForSubmission(submissionId, this.#lifecycle.signal);
				if (this.#stopping) return;
				await this.#finishRun(runId, sessionId, outcome);
			} catch (err) {
				if (!this.#stopping) console.error(`scheduler: watching run ${runId} failed:`, err);
			}
		})();
		this.#watchers.add(watch);
		void watch.finally(() => this.#watchers.delete(watch));
	}

	async #finishRun(
		runId: string,
		sessionId: string,
		outcome: { status: "done" } | { status: "unanswered"; reason: string },
	): Promise<void> {
		const run = await getRun(this.#db, runId);
		if (run?.status !== "running") {
			// Preempted or already settled: drop a quota note that no finish will read.
			this.#quotaDenied.delete(sessionId);
			return;
		}
		const schedule = await getSchedule(this.#db, run.scheduleId);
		let reason: string | null = null;
		if (outcome.status === "unanswered") reason = failureReason(outcome.reason);
		else {
			const denied = await this.#quotaDeniedReason(sessionId, run.startedAt ?? run.createdAt);
			if (denied) reason = denied;
		}
		const status = reason === null ? "succeeded" : "failed";
		const res = await this.#db
			.updateTable("schedule_runs")
			.set({ status, reason, finished_at: this.#now().toISOString() })
			.where("id", "=", runId)
			.where("status", "=", "running")
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return;
		if (schedule) {
			await this.#record(scheduleActor(schedule), "schedule.run_finished", schedule, {
				run_id: runId,
				session_id: sessionId,
				status,
				reason,
			});
		}
	}

	/** Why a run that settled `done` actually failed (e.g. the owner denied its root quota). */
	async #quotaDeniedReason(sessionId: string, since: string): Promise<string | undefined> {
		const noted = this.#quotaDenied.get(sessionId);
		if (noted) {
			this.#quotaDenied.delete(sessionId);
			return noted;
		}
		// After a restart the in-memory note is gone; the audit says whether the owner denied the quota.
		const row = await this.#db
			.selectFrom("audit_events")
			.select("id")
			.where("action", "=", "quota.denied")
			.where("target_type", "=", "session")
			.where("target_id", "=", sessionId)
			.where("ts", ">=", since)
			.limit(1)
			.executeTakeFirst();
		return row ? "the owner denied the token quota" : undefined;
	}

	async #failRun(runId: string, reason: string): Promise<void> {
		const run = await getRun(this.#db, runId);
		if (!run) return;
		const schedule = await getSchedule(this.#db, run.scheduleId);
		if (!schedule) return;
		await this.#fail(schedule, runId, reason, run.sessionId ?? undefined);
	}

	async #fail(schedule: Schedule, runId: string, reason: string, sessionId?: string): Promise<void> {
		const res = await this.#db
			.updateTable("schedule_runs")
			.set({ status: "failed", reason, finished_at: this.#now().toISOString() })
			.where("id", "=", runId)
			.where("status", "in", ["pending", "running"])
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return;
		await this.#record(scheduleActor(schedule), "schedule.run_finished", schedule, {
			run_id: runId,
			session_id: sessionId ?? null,
			status: "failed",
			reason,
		});
	}

	// ---- recovery ----

	/**
	 * Stops the sessions of `preempted` runs that are still active (doc/design/scheduling.md "Triggering and submission"): preemption marks the
	 * run first and stops its session second, so a crash in between leaves a run marked but its session running.
	 * Done before leftover pending runs are submitted, so the two instances never overlap.
	 */
	async #stopPreempted(): Promise<void> {
		const rows = await this.#db
			.selectFrom("schedule_runs")
			.select(["id", "schedule_id", "fire_time", "session_id"])
			.where("status", "=", "preempted")
			.where("session_id", "is not", null)
			.execute();
		if (rows.length === 0) return;
		const active = await this.#runtime.unsettledSubmissionRequests();
		for (const row of rows) {
			if (this.#stopping) return;
			if (!active.has(this.#requestId(row.schedule_id, row.fire_time))) continue;
			try {
				// The session's normal stop path; stopping an already finished session is a no-op.
				await this.#runtime.abort(row.session_id as string);
				console.warn(
					`scheduler: stopped session ${row.session_id} of preempted run ${row.id}; it was still running after a restart`,
				);
			} catch (err) {
				console.error(`scheduler: stopping the session of preempted run ${row.id} failed:`, err);
			}
		}
	}

	/** Submits leftover pending runs, reconciles running ones whose session already finished, then the loop starts. */
	async #recover(): Promise<void> {
		// A crash between marking a run preempted and stopping its session leaves it running; end it first.
		await this.#stopPreempted();
		// Read the running runs first: one that submitPending starts below already has its watcher.
		const runs = await this.#db.selectFrom("schedule_runs").selectAll().where("status", "=", "running").execute();
		await this.#submitPending();
		for (const run of runs) {
			if (this.#stopping) return;
			// A leftover pending run submitted above may have preempted this one.
			if ((await getRun(this.#db, run.id))?.status !== "running") continue;
			const schedule = await getSchedule(this.#db, run.schedule_id);
			if (!schedule) continue;
			if (!run.session_id) {
				await this.#fail(schedule, run.id, "the run never started");
				continue;
			}
			const owner = await this.#ownerUser(schedule.ownerUserId);
			if (!owner) {
				await this.#fail(schedule, run.id, "the schedule's owner is disabled", run.session_id);
				continue;
			}
			try {
				// Durable returns the existing submission for a known request id, so nothing is sent twice.
				const submissionId = await this.#runtime.submitAsSchedule(
					run.session_id,
					schedule.id,
					schedule.prompt,
					this.#requestId(schedule.id, run.fire_time),
					{ checkQuota: false },
				);
				this.#watchRun(run.id, run.session_id, submissionId);
			} catch (err) {
				await this.#fail(schedule, run.id, errorText(err), run.session_id);
			}
		}
	}

	// ---- helpers ----

	#requestId(scheduleId: string, fireTime: string): string {
		return `schedule:${scheduleId}:${fireTime}`;
	}

	async #ownerUser(ownerUserId: string): Promise<SessionUser | undefined> {
		const row = await this.#db
			.selectFrom("users")
			.select(["id", "username", "kind", "status"])
			.where("id", "=", ownerUserId)
			.executeTakeFirst();
		if (row?.status !== "active") return undefined;
		return { sessionId: "scheduler", userId: row.id, username: row.username, kind: row.kind };
	}

	async #record(actor: AuditActor, action: string, schedule: Schedule, detail: Record<string, unknown>): Promise<void> {
		await this.#audit?.record({
			actor,
			action,
			target: { type: "schedule", id: schedule.id },
			detail,
		});
	}

	/**
	 * Disables every schedule of a user about to be disabled (doc/design/scheduling.md "Lifecycle"); the caller passes the
	 * audit record so the chain order matches the user update.
	 */
	static async disableForOwner(db: Db, ownerUserId: string, audit: Audit, actor: AuditActor): Promise<Schedule[]> {
		return disableSchedulesOfOwner(db, ownerUserId, async (schedule) => {
			await audit.record({
				actor,
				action: "schedule.disabled",
				target: { type: "schedule", id: schedule.id },
				detail: { reason: "owner_disabled" },
			});
		});
	}
}
