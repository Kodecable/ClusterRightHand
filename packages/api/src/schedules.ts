/**
 * Schedules (doc/design/scheduling.md): a schedule, its runs and the create/update
 * body.
 */

import type { RefMap } from "./common.ts";
import type { ModelRef } from "./models.ts";
import type { Rule, RulePreset } from "./policy.ts";

export type ScheduleRunStatus = "pending" | "running" | "succeeded" | "failed" | "preempted";

/** One firing of a schedule (doc/design/scheduling.md "Triggering and submission"). */
export interface ScheduleRunView {
	id: string;
	scheduleId: string;
	fireTime: string;
	manual: boolean;
	status: ScheduleRunStatus;
	/** The session the run created, derived from its id. */
	sessionId: string | null;
	reason: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

/** A schedule and what the list shows about it (doc/design/scheduling.md "Schedule model"). */
export interface ScheduleView {
	id: string;
	ownerUserId: string;
	name: string;
	prompt: string;
	model: ModelRef;
	rulePreset: RulePreset | null;
	rules: Rule[];
	/** Display names for the UUIDs referenced by `rules`; null means the object was deleted. */
	refs: RefMap;
	tokenBudget: number | null;
	cron: string;
	timezone: string;
	catchUp: boolean;
	enabled: boolean;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
	lastRun: ScheduleRunView | null;
	/** Whether a run is in progress right now (a "Run now" would stop it). */
	inProgress: boolean;
	/** The next few fire times, computed by the server for the form. */
	preview: string[];
	/** Why the preview is empty, when the stored cron or timezone no longer validates. */
	previewError: string | null;
}

/** Body of `POST /api/schedules` and `PATCH /api/schedules/:id`. */
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
