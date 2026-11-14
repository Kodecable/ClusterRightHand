/**
 * Runtime schemas for schedules (`../schedules.ts`, doc/design/scheduling.md): a schedule, its runs
 * and the create/update bodies.
 */
import { z } from "zod";
import { cursorPageSchema, RefMapSchema } from "./common.ts";
import { ModelRefSchema } from "./models.ts";
import { RulePresetSchema, RuleSchema } from "./policy.ts";

export const ScheduleRunStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "preempted"]);

/** One firing of a schedule (doc/design/scheduling.md "Triggering and submission"). */
export const ScheduleRunViewSchema = z
	.object({
		id: z.string(),
		scheduleId: z.string(),
		fireTime: z.string(),
		manual: z.boolean(),
		status: ScheduleRunStatusSchema,
		sessionId: z.string().nullable().describe("The session the run created, derived from its id."),
		reason: z.string().nullable(),
		createdAt: z.string(),
		startedAt: z.string().nullable(),
		finishedAt: z.string().nullable(),
	})
	.meta({ id: "ScheduleRunView" });

/** A schedule and what the list shows about it (doc/design/scheduling.md "Schedule model"). */
export const ScheduleViewSchema = z
	.object({
		id: z.string(),
		ownerUserId: z.string(),
		name: z.string(),
		prompt: z.string(),
		model: ModelRefSchema,
		rulePreset: RulePresetSchema.nullable(),
		rules: z.array(RuleSchema),
		refs: RefMapSchema.describe(
			"Display names for the UUIDs referenced by `rules`; null means the object was deleted.",
		),
		tokenBudget: z.number().nullable(),
		cron: z.string(),
		timezone: z.string(),
		catchUp: z.boolean(),
		enabled: z.boolean(),
		nextRunAt: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
		lastRun: ScheduleRunViewSchema.nullable(),
		inProgress: z.boolean().describe('Whether a run is in progress right now (a "Run now" would stop it).'),
		preview: z.array(z.string()).describe("The next few fire times, computed by the server for the form."),
		previewError: z
			.string()
			.nullable()
			.describe("Why the preview is empty, when the stored cron or timezone no longer validates."),
	})
	.meta({ id: "ScheduleView" });

export const ScheduleListResponseSchema = z.object({ schedules: z.array(ScheduleViewSchema) });
export const ScheduleResponseSchema = z.object({ schedule: ScheduleViewSchema });
export const ScheduleRunResponseSchema = z.object({ run: ScheduleRunViewSchema });

/** `GET /api/schedules/{id}/runs`: one page of runs, newest first. */
export const ScheduleRunsResponseSchema = cursorPageSchema(ScheduleRunViewSchema).meta({ id: "ScheduleRunsResponse" });

/** `POST /api/schedules`: the fields a new schedule is created from. */
export const ScheduleCreateBodySchema = z.object({
	name: z.string(),
	prompt: z.string(),
	model: ModelRefSchema,
	rulePreset: RulePresetSchema.optional().describe('The starting rules; "ask" by default.'),
	tokenBudget: z.unknown().optional().describe("A positive integer, or null for unlimited."),
	cron: z.string().describe("A five-field cron expression."),
	timezone: z.string().describe("An IANA time zone."),
	catchUp: z.boolean().optional(),
	enabled: z.boolean().optional().describe("true by default."),
});

/** `PATCH /api/schedules/{id}`: any of the create fields; omitted fields keep their value. */
export const SchedulePatchBodySchema = z.object({
	name: z.string().optional(),
	prompt: z.string().optional(),
	model: ModelRefSchema.optional(),
	rulePreset: RulePresetSchema.optional(),
	tokenBudget: z.unknown().optional().describe("A positive integer, or null for unlimited."),
	cron: z.string().optional(),
	timezone: z.string().optional(),
	catchUp: z.boolean().optional(),
	enabled: z.boolean().optional(),
});

/** `POST /api/schedules/preview`: computes the next fire times without saving anything. */
export const SchedulePreviewBodySchema = z.object({
	cron: z.string().optional().describe('The cron expression; "" when omitted.'),
	timezone: z.string().optional().describe('The IANA time zone; "" when omitted.'),
	count: z.number().optional().describe("How many times to compute; 5 by default."),
});

export const SchedulePreviewResponseSchema = z.object({ times: z.array(z.string()) });
