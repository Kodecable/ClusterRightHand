import { type Context, Hono } from "hono";
import type { ModelConfig, ModelRef } from "../agent/models.ts";
import { parseModelRef } from "../agent/models.ts";
import { userActor } from "../audit/audit.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { parsePreset } from "../policy/store.ts";
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
import { NotFoundError, UserError } from "../users/service.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";
import { type CursorSpec, cursorRows, decodeCursor, encodeCursor, parseLimit } from "./cursor.ts";

/** `GET /schedules/:id/runs` pages over `fire_time desc, id desc`. */
const RUNS_CURSOR: CursorSpec = { columns: [{ name: "fire_time", type: "string" }], idType: "string" };
const PREVIEW_COUNT = 5;

export interface ScheduleRoutesOptions {
	scheduler: Scheduler;
	models: ModelConfig;
	cluster: Cluster;
	groups: TaskGroups;
}

/** Schedules (doc/scheduling.md); a schedule belongs to its creator, so administrators see only theirs too. */
export function scheduleRoutes(db: Db, options: ScheduleRoutesOptions) {
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		if (err instanceof UserError || err instanceof TypeError) return jsonError(c, 400, err.message);
		throw err;
	});

	/** The schedule's API shape, including what the list and form show about it. */
	async function view(schedule: Schedule) {
		const rules = await scheduleRuleSet(db, schedule.id);
		const [last, running] = await Promise.all([latestRun(db, schedule.id), runInProgress(db, schedule.id)]);
		return {
			id: schedule.id,
			ownerUserId: schedule.ownerUserId,
			name: schedule.name,
			prompt: schedule.prompt,
			model: schedule.model,
			preset: rules?.preset ?? null,
			rules: rules?.rules ?? [],
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
			// The next few fire times, so the form can be checked before saving (doc/scheduling.md#调度).
			preview: previewRuns(schedule.cron, schedule.timezone, options.scheduler.now(), PREVIEW_COUNT),
		};
	}

	/** The caller's own schedule; 404 for anything else, like API tokens. */
	async function own(c: Context<AppEnv>): Promise<Schedule> {
		const schedule = await getSchedule(db, c.req.param("id") as string);
		if (!schedule || schedule.ownerUserId !== c.get("user").userId) throw new NotFoundError("no such schedule");
		return schedule;
	}

	app.get("/schedules", async (c) => {
		const schedules = await listSchedules(db, c.get("user").userId);
		return c.json({ schedules: await Promise.all(schedules.map(view)) });
	});

	/** Computes the next fire times for the form, without saving anything. */
	app.post("/schedules/preview", async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const cron = optionalString(body, "cron") ?? "";
		const timezone = optionalString(body, "timezone") ?? "";
		const count = typeof body.count === "number" ? body.count : PREVIEW_COUNT;
		validateCron(cron, timezone);
		return c.json({ times: previewRuns(cron, timezone, options.scheduler.now(), count) });
	});

	app.post("/schedules", async (c) => {
		const user = c.get("user");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const model = parseModelRef(body.model);
		options.models.assertAvailable(model);
		const schedule = await createSchedule(
			db,
			user.userId,
			{
				name: requiredString(body, "name"),
				prompt: requiredString(body, "prompt"),
				model,
				preset: parsePreset(body.preset ?? "ask"),
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
			detail: scheduleDetail(schedule, { preset: parsePreset(body.preset ?? "ask") }),
		});
		// The loop picks the new trigger up at once (doc/scheduling.md#调度).
		options.scheduler.wake();
		return c.json({ schedule: await view(schedule) }, 201);
	});

	app.get("/schedules/:id", async (c) => c.json({ schedule: await view(await own(c)) }));

	/** `PATCH /api/schedules/:id`: any of the create fields; only cron/timezone/enabled change `next_run_at`. */
	app.patch("/schedules/:id", async (c) => {
		const user = c.get("user");
		const schedule = await own(c);
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const model: ModelRef | undefined = body.model === undefined ? undefined : parseModelRef(body.model);
		if (model) options.models.assertAvailable(model);
		const preset = body.preset === undefined ? undefined : parsePreset(body.preset);
		const updated = await updateSchedule(
			db,
			schedule,
			{
				...(typeof body.name === "string" ? { name: body.name } : {}),
				...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
				...(model ? { model } : {}),
				...(preset ? { preset } : {}),
				...(body.tokenBudget === undefined ? {} : { tokenBudget: parseTokenBudget(body.tokenBudget) }),
				...(typeof body.cron === "string" ? { cron: body.cron } : {}),
				...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
				...(typeof body.catchUp === "boolean" ? { catchUp: body.catchUp } : {}),
				...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
			},
			options.scheduler.now(),
		);
		void c.get("audit").record({
			actor: userActor(user),
			action: "schedule.updated",
			target: { type: "schedule", id: schedule.id },
			detail: {
				...changedDetail(body),
				...(preset ? { preset } : {}),
				next_run_at: updated.nextRunAt,
			},
		});
		if (typeof body.enabled === "boolean" && body.enabled !== schedule.enabled) {
			void c.get("audit").record({
				actor: userActor(user),
				action: body.enabled ? "schedule.enabled" : "schedule.disabled",
				target: { type: "schedule", id: schedule.id },
				detail: { next_run_at: updated.nextRunAt },
			});
		}
		// A preset change can settle already-waiting approvals in the schedule's sessions.
		if (preset) {
			const ref = scheduleRef(schedule.id);
			await options.cluster.reevaluate(ref);
			await options.groups.reevaluate(ref);
		}
		options.scheduler.wake();
		return c.json({ schedule: await view(updated) });
	});

	app.delete("/schedules/:id", async (c) => {
		const user = c.get("user");
		const schedule = await own(c);
		// Deleting stops the running instance and removes the runs; the sessions stay, unlinked (doc/scheduling.md).
		await options.scheduler.remove(schedule.id);
		void c.get("audit").record({
			actor: userActor(user),
			action: "schedule.deleted",
			target: { type: "schedule", id: schedule.id },
			detail: { name: schedule.name },
		});
		options.scheduler.wake();
		return c.json({ ok: true });
	});

	/** Manual run: the same path as a trigger, with the user as actor and `manual = true`. */
	app.post("/schedules/:id/run", async (c) => {
		const user = c.get("user");
		const schedule = await own(c);
		const run = await options.scheduler.runNow(schedule.id, user);
		return c.json({ run }, 202);
	});

	/** Run history, newest first, one keyset page at a time (doc/webui.md#api-约定). */
	app.get("/schedules/:id/runs", async (c) => {
		const schedule = await own(c);
		const limit = parseLimit(c.req.query("limit"));
		const rawCursor = c.req.query("cursor");
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
		return c.json({ items: page.rows, nextCursor: page.nextCursor });
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
