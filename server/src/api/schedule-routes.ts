import {
	CursorQuerySchema,
	IdParamSchema,
	OkResponseSchema,
	ScheduleCreateBodySchema,
	ScheduleListResponseSchema,
	SchedulePatchBodySchema,
	SchedulePreviewBodySchema,
	SchedulePreviewResponseSchema,
	ScheduleResponseSchema,
	ScheduleRunResponseSchema,
	ScheduleRunsResponseSchema,
} from "@crh/api/schemas";
import type { Context } from "hono";
import { type ModelConfig, type ModelRef, modelRefView, parseModelRef, thinkingLevelOf } from "../agent/models.ts";
import { userActor } from "../audit/audit.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { ruleRefs } from "../policy/refs.ts";
import { parseRulePreset } from "../policy/store.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import {
	createSchedule,
	getSchedule,
	latestRun,
	listRuns,
	listSchedules,
	parseTokenBudget,
	previewRuns,
	runInProgress,
	type Schedule,
	scheduleRef,
	scheduleRuleSet,
	updateSchedule,
	validateCron,
} from "../scheduler/store.ts";
import type { Db } from "../storage/db.ts";
import { type CursorSpec, cursorRows, decodeCursor, encodeCursor, parseLimit } from "../util/cursor.ts";
import { errorText, NotFoundError, UserError } from "../util/errors.ts";
import type { AppEnv } from "./context.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

/** `GET /schedules/:id/runs` pages over `fire_time desc, id desc`. */
const RUNS_CURSOR: CursorSpec = { columns: [{ name: "fire_time", type: "string" }], idType: "string" };
const PREVIEW_COUNT = 5;
const TAGS = ["Schedules"];

const listRoute = defineRoute({
	method: "get",
	path: "/schedules",
	tags: TAGS,
	summary: "The caller's own schedules; a schedule is never shared, and administrators see only theirs",
	agent: "allow",
	responses: { 200: { description: "The caller's schedules", ...json(ScheduleListResponseSchema) } },
});

const previewRoute = defineRoute({
	method: "post",
	path: "/schedules/preview",
	tags: TAGS,
	summary: "Compute the next fire times for a cron expression, without saving anything",
	agent: "allow",
	request: { body: { required: true, ...json(SchedulePreviewBodySchema) } },
	responses: { 200: { description: "The computed fire times", ...json(SchedulePreviewResponseSchema) } },
});

const createRoute = defineRoute({
	method: "post",
	path: "/schedules",
	tags: TAGS,
	summary: "Create a schedule; it fires its prompt as the caller with its rule preset",
	agent: "deny", // a schedule with a permissive preset authorizes future calls without the user present
	request: { body: { required: true, ...json(ScheduleCreateBodySchema) } },
	responses: { 201: { description: "The new schedule", ...json(ScheduleResponseSchema) } },
});

const getRoute = defineRoute({
	method: "get",
	path: "/schedules/{id}",
	tags: TAGS,
	summary: "One of the caller's schedules, with its preview and last run",
	agent: "allow",
	request: { params: IdParamSchema },
	responses: { 200: { description: "The schedule", ...json(ScheduleResponseSchema) } },
});

const patchRoute = defineRoute({
	method: "patch",
	path: "/schedules/{id}",
	tags: TAGS,
	summary: "Update a schedule; only cron, timezone and enabled change its next run",
	agent: "deny", // a rule preset change re-arms future calls
	request: { params: IdParamSchema, body: { required: true, ...json(SchedulePatchBodySchema) } },
	responses: { 200: { description: "The updated schedule", ...json(ScheduleResponseSchema) } },
});

const deleteRoute = defineRoute({
	method: "delete",
	path: "/schedules/{id}",
	tags: TAGS,
	summary: "Delete a schedule, stop its running instance and remove its run history",
	agent: "ask",
	request: { params: IdParamSchema },
	responses: { 200: { description: "Deleted", ...json(OkResponseSchema) } },
});

const runRoute = defineRoute({
	method: "post",
	path: "/schedules/{id}/run",
	tags: TAGS,
	summary: "Run a schedule now, as a manual trigger with the caller as actor",
	agent: "ask",
	request: { params: IdParamSchema },
	responses: { 202: { description: "The started run", ...json(ScheduleRunResponseSchema) } },
});

const runsRoute = defineRoute({
	method: "get",
	path: "/schedules/{id}/runs",
	tags: TAGS,
	summary: "Page through a schedule's runs, newest first",
	agent: "allow",
	request: { params: IdParamSchema, query: CursorQuerySchema },
	responses: { 200: { description: "One page of runs", ...json(ScheduleRunsResponseSchema) } },
});

export interface ScheduleRoutesOptions {
	scheduler: Scheduler;
	models: ModelConfig;
	cluster: Cluster;
	taskGroups: TaskGroups;
}

/** Schedules (doc/design/scheduling.md); a schedule belongs to its creator, so administrators see only theirs too. */
export function scheduleRoutes(db: Db, options: ScheduleRoutesOptions) {
	const app = apiRouter();

	/** The schedule's API shape, including what the list and form show about it. */
	async function view(schedule: Schedule) {
		const rules = await scheduleRuleSet(db, schedule.id);
		const [last, running] = await Promise.all([latestRun(db, schedule.id), runInProgress(db, schedule.id)]);
		// A row saved before cron/timezone were validated must not fail the list: an invalid stored
		// pair leaves the preview empty and says why (doc/design/scheduling.md "Triggering and submission").
		let preview: string[] = [];
		let previewError: string | null = null;
		try {
			preview = previewRuns(schedule.cron, schedule.timezone, options.scheduler.now(), PREVIEW_COUNT);
		} catch (err) {
			previewError = errorText(err);
		}
		return {
			id: schedule.id,
			ownerUserId: schedule.ownerUserId,
			name: schedule.name,
			prompt: schedule.prompt,
			model: modelRefView(schedule.model),
			rulePreset: rules?.rulePreset ?? null,
			rules: rules?.rules ?? [],
			refs: await ruleRefs(db, schedule.orgId, rules?.rules ?? []),
			tokenBudget: schedule.tokenBudget,
			cron: schedule.cron,
			timezone: schedule.timezone,
			catchUp: schedule.catchUp,
			enabled: schedule.enabled,
			nextRunAt: schedule.nextRunAt,
			createdAt: schedule.createdAt,
			updatedAt: schedule.updatedAt,
			lastRun: last ?? null,
			inProgress: running !== undefined,
			// The next few fire times, so the form can be checked before saving (doc/design/scheduling.md "Triggering and submission").
			preview,
			// Why the preview is empty, when the stored cron or timezone is invalid.
			previewError,
		};
	}

	/** The caller's own schedule; 404 for anything else, like API tokens. */
	async function own(c: Context<AppEnv>, id: string): Promise<Schedule> {
		const schedule = await getSchedule(db, id);
		if (!schedule || schedule.ownerUserId !== c.get("user").userId) throw new NotFoundError("no such schedule");
		return schedule;
	}

	app.openapi(listRoute, async (c) => {
		const schedules = await listSchedules(db, c.get("user").userId);
		return c.json({ schedules: await Promise.all(schedules.map(view)) }, 200);
	});

	/** Computes the next fire times for the form, without saving anything. */
	app.openapi(previewRoute, async (c) => {
		const body = c.req.valid("json");
		const cron = body.cron ?? "";
		const timezone = body.timezone ?? "";
		const count = body.count ?? PREVIEW_COUNT;
		validateCron(cron, timezone);
		return c.json({ times: previewRuns(cron, timezone, options.scheduler.now(), count) }, 200);
	});

	app.openapi(createRoute, async (c) => {
		const user = c.get("user");
		const body = c.req.valid("json");
		// Creating has no previous model: no level means off, an explicit level must be supported.
		const model = options.models.resolveRef(parseModelRef(body.model));
		const rulePreset = parseRulePreset(body.rulePreset ?? "ask");
		const schedule = await createSchedule(
			db,
			user.userId,
			{
				name: requiredString(body, "name"),
				prompt: requiredString(body, "prompt"),
				model,
				rulePreset,
				tokenBudget: parseTokenBudget(body.tokenBudget),
				cron: requiredString(body, "cron"),
				timezone: requiredString(body, "timezone"),
				catchUp: body.catchUp === true,
				enabled: body.enabled !== false,
			},
			options.scheduler.now(),
		);
		void c.get("audit").record({
			actor: userActor(user),
			action: "schedule.created",
			target: { type: "schedule", id: schedule.id },
			detail: scheduleDetail(schedule, { rule_preset: rulePreset }),
		});
		// The loop picks the new trigger up at once (doc/design/scheduling.md "Triggering and submission").
		options.scheduler.wake();
		return c.json({ schedule: await view(schedule) }, 201);
	});

	app.openapi(getRoute, async (c) => c.json({ schedule: await view(await own(c, c.req.valid("param").id)) }, 200));

	/** `PATCH /api/schedules/:id`: any of the create fields; only cron/timezone/enabled change `next_run_at`. */
	app.openapi(patchRoute, async (c) => {
		const user = c.get("user");
		const schedule = await own(c, c.req.valid("param").id);
		const body = c.req.valid("json");
		// A model change without a level keeps the schedule's level, clamped to the new model.
		const model: ModelRef | undefined =
			body.model === undefined
				? undefined
				: options.models.resolveRef(parseModelRef(body.model), thinkingLevelOf(schedule.model));
		const rulePreset = body.rulePreset === undefined ? undefined : parseRulePreset(body.rulePreset);
		const updated = await updateSchedule(
			db,
			schedule,
			{
				...(body.name === undefined ? {} : { name: body.name }),
				...(body.prompt === undefined ? {} : { prompt: body.prompt }),
				...(model ? { model } : {}),
				...(rulePreset ? { rulePreset } : {}),
				...(body.tokenBudget === undefined ? {} : { tokenBudget: parseTokenBudget(body.tokenBudget) }),
				...(body.cron === undefined ? {} : { cron: body.cron }),
				...(body.timezone === undefined ? {} : { timezone: body.timezone }),
				...(body.catchUp === undefined ? {} : { catchUp: body.catchUp }),
				...(body.enabled === undefined ? {} : { enabled: body.enabled }),
			},
			options.scheduler.now(),
		);
		void c.get("audit").record({
			actor: userActor(user),
			action: "schedule.updated",
			target: { type: "schedule", id: schedule.id },
			detail: {
				...changedDetail(body),
				...(rulePreset ? { rule_preset: rulePreset } : {}),
				next_run_at: updated.nextRunAt,
			},
		});
		if (body.enabled !== undefined && body.enabled !== schedule.enabled) {
			void c.get("audit").record({
				actor: userActor(user),
				action: body.enabled ? "schedule.enabled" : "schedule.disabled",
				target: { type: "schedule", id: schedule.id },
				detail: { next_run_at: updated.nextRunAt },
			});
		}
		// A rule preset change can settle already-waiting approvals in the schedule's sessions.
		if (rulePreset) {
			const ref = scheduleRef(schedule.id);
			await options.cluster.reevaluate(ref);
			await options.taskGroups.reevaluate(ref);
		}
		options.scheduler.wake();
		return c.json({ schedule: await view(updated) }, 200);
	});

	app.openapi(deleteRoute, async (c) => {
		const user = c.get("user");
		const schedule = await own(c, c.req.valid("param").id);
		// Deleting stops the running instance and removes the runs; the sessions stay, unlinked (doc/design/scheduling.md).
		await options.scheduler.remove(schedule.id);
		void c.get("audit").record({
			actor: userActor(user),
			action: "schedule.deleted",
			target: { type: "schedule", id: schedule.id },
			detail: { name: schedule.name },
		});
		options.scheduler.wake();
		return c.json({ ok: true as const }, 200);
	});

	/** Manual run: the same path as a trigger, with the user as actor and `manual = true`. */
	app.openapi(runRoute, async (c) => {
		const user = c.get("user");
		const schedule = await own(c, c.req.valid("param").id);
		const run = await options.scheduler.runNow(schedule.id, user);
		return c.json({ run }, 202);
	});

	/** Run history, newest first, one keyset page at a time (doc/design/webui.md "API conventions"). */
	app.openapi(runsRoute, async (c) => {
		const schedule = await own(c, c.req.valid("param").id);
		const query = c.req.valid("query");
		const limit = parseLimit(query.limit);
		const rawCursor = query.cursor;
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, RUNS_CURSOR);
		const page = await cursorRows(
			limit,
			(limitPlusOne) =>
				listRuns(
					db,
					schedule.id,
					limitPlusOne,
					cursor ? { fireTime: String(cursor.values[0]), id: String(cursor.id) } : undefined,
				),
			(run) => encodeCursor([run.fireTime], run.id),
		);
		return c.json({ items: page.rows, nextCursor: page.nextCursor }, 200);
	});

	return app;
}

function requiredString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || !value.trim()) throw new UserError(`${key} is required`);
	return value;
}

/** Which fields changed, without copying the (possibly long) prompt into the audit log. */
function changedDetail(body: Record<string, unknown>): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const key of ["name", "cron", "timezone", "catchUp", "enabled", "tokenBudget"]) {
		if (body[key] !== undefined) fields[key] = body[key];
	}
	if (body.model !== undefined) fields.model = body.model;
	if (typeof body.prompt === "string") fields.prompt_chars = body.prompt.length;
	return fields;
}

function scheduleDetail(schedule: Schedule, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: schedule.name,
		cron: schedule.cron,
		timezone: schedule.timezone,
		catch_up: schedule.catchUp,
		enabled: schedule.enabled,
		token_budget: schedule.tokenBudget,
		model: schedule.model,
		next_run_at: schedule.nextRunAt,
		...extra,
	};
}
