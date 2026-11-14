/**
 * Schedules (doc/design/scheduling.md): a schedule, its runs and the create/update
 * body.
 */

import type { z } from "zod";
import type { ModelRef } from "./models.ts";
import type { RulePreset } from "./policy.ts";
import type {
	SchedulePatchBodySchema,
	ScheduleRunStatusSchema,
	ScheduleRunViewSchema,
	ScheduleViewSchema,
} from "./schemas/schedules.ts";

export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatusSchema>;

/** One firing of a schedule (doc/design/scheduling.md "Triggering and submission"). */
export type ScheduleRunView = z.infer<typeof ScheduleRunViewSchema>;

/** A schedule and what the list shows about it (doc/design/scheduling.md "Schedule model"). */
export type ScheduleView = z.infer<typeof ScheduleViewSchema>;

/**
 * Body of `POST /api/schedules` and `PATCH /api/schedules/:id`. `tokenBudget` stays untyped in the
 * schema because a value that is not a positive integer or null is a documented 400, not a schema
 * failure; the create form sends this full shape.
 */
export interface ScheduleInput {
	name: string;
	prompt: string;
	model: ModelRef;
	rulePreset: RulePreset;
	tokenBudget: number | null;
	cron: string;
	timezone: string;
	catchUp: boolean;
	enabled: boolean;
}

/** The update body: any of the create fields, all optional. */
export type ScheduleUpdateInput = z.infer<typeof SchedulePatchBodySchema>;
