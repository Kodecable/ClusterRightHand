import type { ScheduleInput, ScheduleRunView } from "@crh/api";
import { Cron } from "croner";
import { type Selectable, sql } from "kysely";
import type { ModelRef } from "../agent/models.ts";
import type { AuditActor } from "../audit/audit.ts";
import type { Rule, RulePreset } from "../policy/rules.ts";
import { createRootRuleSet, getRuleSet, type RuleRef, type StoredRuleSet, setRulePreset } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import type { ScheduleRunsTable, SchedulesTable } from "../storage/schema.ts";
import { defaultOrgId } from "../users/service.ts";
import { errorText, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";

/**
 * Scheduled runs (doc/scheduling.md): a cron that creates a new session and submits a fixed prompt. This module
 * holds the stored shape and the cron arithmetic; the loop that fires and submits is scheduler.ts.
 */

/** A schedule as stored, parsed. */
export interface Schedule {
	id: string;
	orgId: string;
	ownerUserId: string;
	name: string;
	prompt: string;
	model: ModelRef;
	/** The new session's root quota; null means unlimited. */
	tokenBudget: number | null;
	cron: string;
	timezone: string;
	catchUp: boolean;
	enabled: boolean;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export type ScheduleRun = ScheduleRunView;

/** How late a due trigger may be and still count as that trigger (doc/scheduling.md#调度). */
export const MISSED_TOLERANCE_MS = 60_000;

function parseRun(row: Selectable<ScheduleRunsTable>): ScheduleRun {
	return {
		id: row.id,
		scheduleId: row.schedule_id,
		fireTime: row.fire_time,
		manual: row.manual === 1,
		status: row.status,
		sessionId: row.session_id,
		reason: row.reason,
		createdAt: row.created_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
	};
}

function parseSchedule(row: Selectable<SchedulesTable>): Schedule {
	return {
		id: row.id,
		orgId: row.org_id,
		ownerUserId: row.owner_user_id,
		name: row.name,
		prompt: row.prompt,
		model: JSON.parse(row.model) as ModelRef,
		tokenBudget: row.token_budget === null ? null : Number(row.token_budget),
		cron: row.cron,
		timezone: row.timezone,
		catchUp: row.catch_up === 1,
		enabled: row.enabled === 1,
		nextRunAt: row.next_run_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** A croner instance for a 5-field pattern in an IANA timezone; throws UserError when either is invalid. */
function cronOf(cron: string, timezone: string): Cron {
	if (typeof cron !== "string" || cron.trim() === "") throw new UserError("cron is required");
	if (typeof timezone !== "string" || timezone.trim() === "") throw new UserError("timezone is required");
	const zone = timezone.trim();
	// croner accepts an unknown zone at construction and fails only when it computes a time, which a disabled
	// schedule never does: check the zone now with the same IANA resolution croner will use later.
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
	} catch {
		throw new UserError(`invalid timezone: ${zone}`);
	}
	try {
		// "5-part" pins the minute precision the docs promise; 6- and 7-field patterns are rejected.
		return new Cron(cron.trim(), { timezone: zone, paused: true, mode: "5-part" });
	} catch (err) {
		throw new UserError(`invalid cron or timezone: ${errorText(err).replace(/^Cron[A-Za-z]*: /, "")}`);
	}
}

/** Validates a cron expression and its timezone; throws UserError. */
export function validateCron(cron: string, timezone: string): void {
	cronOf(cron, timezone);
}

/** Thrown when a cron expression has no further fire time (for example a date that never comes). */
export class NeverFiresError extends UserError {
	constructor() {
		super("the cron expression never fires");
	}
}

/** The next fire time after `from`, as an ISO 8601 UTC string. */
export function nextRunAfter(cron: string, timezone: string, from: Date): string {
	const next = cronOf(cron, timezone).nextRun(from);
	if (!next) throw new NeverFiresError();
	return next.toISOString();
}

/** The next `count` fire times after `from`; invalid input throws, so the form can show the reason. */
export function previewRuns(cron: string, timezone: string, from: Date, count = 5): string[] {
	return cronOf(cron, timezone)
		.nextRuns(Math.max(1, Math.min(count, 20)), from)
		.map((d) => d.toISOString());
}

/**
 * The most recent fire time at or before `at`, or undefined when the pattern never fired. croner's
 * `previousRuns` is exclusive of its reference, so the reference is nudged by a second (the patterns are
 * minute-precision); catching up a trigger that is due this very minute is right, it has not fired.
 */
export function lastRunAtOrBefore(cron: string, timezone: string, at: Date): Date | undefined {
	const previous = cronOf(cron, timezone).previousRuns(1, new Date(at.getTime() + 1_000));
	return previous[0];
}

/** Fields a user may set; the API validates them before they reach here. */
export type { ScheduleInput };

function validName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 200) throw new UserError("name must be 1 to 200 characters");
	return trimmed;
}

function validPrompt(prompt: string): string {
	if (!prompt.trim()) throw new UserError("prompt is required");
	if (prompt.length > 100_000) throw new UserError("prompt is too long");
	return prompt;
}

/** A schedule's token budget: null for unlimited, or at least one token (doc/scheduling.md#授权规则与配额). */
export function parseTokenBudget(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
		throw new UserError("tokenBudget must be a positive integer, or null for unlimited");
	}
	return raw;
}

/** Creates the schedule and its rule-chain root (with the rule preset) in one transaction. */
export async function createSchedule(
	db: Db,
	ownerUserId: string,
	input: ScheduleInput,
	at = new Date(),
): Promise<Schedule> {
	validateCron(input.cron, input.timezone);
	const id = newId();
	const orgId = await defaultOrgId(db);
	const now = at.toISOString();
	const nextRunAt = input.enabled ? nextRunAfter(input.cron, input.timezone, at) : null;
	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("schedules")
			.values({
				id,
				org_id: orgId,
				owner_user_id: ownerUserId,
				name: validName(input.name),
				prompt: validPrompt(input.prompt),
				model: JSON.stringify(input.model),
				token_budget: parseTokenBudget(input.tokenBudget),
				cron: input.cron.trim(),
				timezone: input.timezone.trim(),
				catch_up: input.catchUp ? 1 : 0,
				enabled: input.enabled ? 1 : 0,
				next_run_at: nextRunAt,
				created_at: now,
				updated_at: now,
			})
			.execute();
		await createRootRuleSet(trx, orgId, { type: "schedule", id }, input.rulePreset);
	});
	return (await getSchedule(db, id)) as Schedule;
}

export async function getSchedule(db: Db, id: string): Promise<Schedule | undefined> {
	const row = await db.selectFrom("schedules").selectAll().where("id", "=", id).executeTakeFirst();
	return row ? parseSchedule(row) : undefined;
}

/** A user's own schedules; schedules are never shared, so administrators see only theirs too. */
export async function listSchedules(db: Db, ownerUserId: string): Promise<Schedule[]> {
	const rows = await db
		.selectFrom("schedules")
		.selectAll()
		.where("owner_user_id", "=", ownerUserId)
		.orderBy("created_at", "desc")
		.execute();
	return rows.map(parseSchedule);
}

/** The rule set of a schedule (the root of its chain); includes the rule preset the form edits. */
export async function scheduleRuleSet(db: Db, id: string): Promise<StoredRuleSet | null> {
	return (await getRuleSet(db, { type: "schedule", id })) ?? null;
}

export interface SchedulePatch {
	name?: string;
	prompt?: string;
	model?: ModelRef;
	rulePreset?: RulePreset;
	tokenBudget?: number | null;
	cron?: string;
	timezone?: string;
	catchUp?: boolean;
	enabled?: boolean;
}

/**
 * Applies a partial change and recomputes `next_run_at` when the cron, the timezone or `enabled` changed
 * (doc/scheduling.md#生命周期). Changing the prompt, model, rule preset or budget only affects later runs.
 */
export async function updateSchedule(
	db: Db,
	schedule: Schedule,
	patch: SchedulePatch,
	at = new Date(),
): Promise<Schedule> {
	const cron = patch.cron === undefined ? schedule.cron : patch.cron.trim();
	const timezone = patch.timezone === undefined ? schedule.timezone : patch.timezone.trim();
	const enabled = patch.enabled === undefined ? schedule.enabled : patch.enabled;
	const timingChanged = cron !== schedule.cron || timezone !== schedule.timezone || enabled !== schedule.enabled;
	if (timingChanged) validateCron(cron, timezone);
	const now = at;
	const nextRunAt = !enabled ? null : timingChanged ? nextRunAfter(cron, timezone, at) : schedule.nextRunAt;
	await db.transaction().execute(async (trx) => {
		await trx
			.updateTable("schedules")
			.set({
				...(patch.name === undefined ? {} : { name: validName(patch.name) }),
				...(patch.prompt === undefined ? {} : { prompt: validPrompt(patch.prompt) }),
				...(patch.model === undefined ? {} : { model: JSON.stringify(patch.model) }),
				...(patch.tokenBudget === undefined ? {} : { token_budget: parseTokenBudget(patch.tokenBudget) }),
				...(patch.catchUp === undefined ? {} : { catch_up: patch.catchUp ? 1 : 0 }),
				cron,
				timezone,
				enabled: enabled ? 1 : 0,
				next_run_at: nextRunAt,
				updated_at: now.toISOString(),
			})
			.where("id", "=", schedule.id)
			.execute();
		if (patch.rulePreset !== undefined)
			await setRulePreset(trx, { type: "schedule", id: schedule.id }, patch.rulePreset);
	});
	return (await getSchedule(db, schedule.id)) as Schedule;
}

/**
 * Removes a schedule: its runs go with it (foreign key), its sessions keep no link (foreign key sets the column
 * null). The rule set stays, like an API token's, so the chains of past tasks keep resolving; each session a run
 * created is promoted to a root with the schedule's rule preset first (its own rule set was an inherit-only level).
 * Returns the sessions that lost their schedule, so the caller can publish the change to the session list.
 *
 * The select, the promotions and the deletions share one transaction: a session inserted between a separate select
 * and the link update would keep an inherit-only rule set with no root above it, and every evaluation of its chain
 * would throw. The caller also serializes this with the schedule's submit, so no new session is in flight here.
 */
export async function deleteSchedule(db: Db, schedule: Schedule): Promise<string[]> {
	return await db.transaction().execute(async (trx) => {
		const rules = await getRuleSet(trx, { type: "schedule", id: schedule.id });
		const sessions = await trx.selectFrom("sessions").select("id").where("schedule_id", "=", schedule.id).execute();
		for (const session of sessions) {
			await promoteSessionRuleSet(trx, schedule.orgId, session.id, rules?.rulePreset ?? "ask", rules?.rules ?? []);
		}
		await trx.deleteFrom("schedule_runs").where("schedule_id", "=", schedule.id).execute();
		await trx
			.updateTable("sessions")
			.set({ schedule_id: null, updated_at: new Date().toISOString() })
			.where("schedule_id", "=", schedule.id)
			.execute();
		await trx.deleteFrom("schedules").where("id", "=", schedule.id).execute();
		return sessions.map((session) => session.id);
	});
}

/** Replaces a scheduled session's rule set with a root-level one that keeps the schedule's policy. */
async function promoteSessionRuleSet(
	db: Db,
	orgId: string,
	sessionId: string,
	rulePreset: RulePreset,
	rules: Rule[],
): Promise<void> {
	await db.deleteFrom("rule_sets").where("scope_type", "=", "session").where("scope_id", "=", sessionId).execute();
	await createRootRuleSet(db, orgId, { type: "session", id: sessionId }, rulePreset, rules);
}

export async function getRun(db: Db, id: string): Promise<ScheduleRun | undefined> {
	const row = await db.selectFrom("schedule_runs").selectAll().where("id", "=", id).executeTakeFirst();
	return row ? parseRun(row) : undefined;
}

/** Newest first; `before` continues `fire_time desc, id desc` (doc/webui.md#api-约定) for GET /schedules/:id/runs. */
export async function listRuns(
	db: Db,
	scheduleId: string,
	limit: number,
	before?: { fireTime: string; id: string },
): Promise<ScheduleRun[]> {
	let query = db.selectFrom("schedule_runs").selectAll().where("schedule_id", "=", scheduleId);
	if (before) {
		// Same keyset shape as the cursor helper writes, kept local so this module has no API import.
		query = query.where(
			sql<boolean>`(fire_time < ${before.fireTime} OR (fire_time = ${before.fireTime} AND id < ${before.id}))`,
		);
	}
	const rows = await query.orderBy("fire_time", "desc").orderBy("id", "desc").limit(limit).execute();
	return rows.map(parseRun);
}

/** The schedule's latest run (whatever its status). */
export async function latestRun(db: Db, scheduleId: string): Promise<ScheduleRun | undefined> {
	const row = await db
		.selectFrom("schedule_runs")
		.selectAll()
		.where("schedule_id", "=", scheduleId)
		.orderBy("fire_time", "desc")
		.orderBy("id", "desc")
		.limit(1)
		.executeTakeFirst();
	return row ? parseRun(row) : undefined;
}

/** Whether a run of the schedule is in progress right now. */
export async function runInProgress(db: Db, scheduleId: string): Promise<ScheduleRun | undefined> {
	const row = await db
		.selectFrom("schedule_runs")
		.selectAll()
		.where("schedule_id", "=", scheduleId)
		.where("status", "in", ["pending", "running"])
		.orderBy("fire_time", "desc")
		.limit(1)
		.executeTakeFirst();
	return row ? parseRun(row) : undefined;
}

/** The actor a scheduler decision is recorded with (doc/access-control.md#操作者). */
export function scheduleActor(schedule: Schedule): AuditActor {
	return { type: "system", id: "scheduler", onBehalfOfUserId: schedule.ownerUserId };
}

/**
 * Disables every enabled schedule of a user who was just disabled (doc/scheduling.md#生命周期) and audits each.
 * Audits are written by the caller's Audit instance so the chain order stays with the user update.
 */
export async function disableSchedulesOfOwner(
	db: Db,
	ownerUserId: string,
	audit: (schedule: Schedule) => Promise<void>,
): Promise<Schedule[]> {
	const rows = await db
		.selectFrom("schedules")
		.selectAll()
		.where("owner_user_id", "=", ownerUserId)
		.where("enabled", "=", 1)
		.execute();
	const schedules = rows.map(parseSchedule);
	for (const schedule of schedules) {
		await db
			.updateTable("schedules")
			.set({ enabled: 0, next_run_at: null, updated_at: new Date().toISOString() })
			.where("id", "=", schedule.id)
			.execute();
		await audit({ ...schedule, enabled: false, nextRunAt: null });
	}
	return schedules;
}

/** The rule ref of a schedule, for reevaluating waiting tasks after a rule preset change. */
export function scheduleRef(id: string): RuleRef {
	return { type: "schedule", id };
}
