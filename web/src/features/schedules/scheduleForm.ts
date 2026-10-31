import type { ModelRef, Preset, ScheduleRunStatus, ScheduleRunView, ScheduleView } from "@/lib/api/types";
import { parseQuotaInput } from "@/lib/quota";

/** Pure form and display helpers for schedules (doc/scheduling.md); the pages only render them. */

export interface ScheduleFormState {
	name: string;
	prompt: string;
	model: ModelRef | undefined;
	preset: Preset;
	tokenBudget: string;
	cron: string;
	timezone: string;
	catchUp: boolean;
	enabled: boolean;
}

export interface ScheduleFormErrors {
	name?: string;
	prompt?: string;
	model?: string;
	tokenBudget?: string;
	cron?: string;
	timezone?: string;
}

export interface ParsedSchedule {
	name: string;
	prompt: string;
	model: ModelRef;
	preset: Preset;
	tokenBudget: number | null;
	cron: string;
	timezone: string;
	catchUp: boolean;
	enabled: boolean;
}

/** The browser's timezone, used as the form's default; "UTC" when it cannot be determined. */
export function defaultTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** The schedule's budget: empty for unlimited, or at least one token (doc/scheduling.md#授权规则与配额). */
function parseBudgetInput(text: string): { quota: number | null } | { error: string } {
	const parsed = parseQuotaInput(text);
	if ("error" in parsed) {
		return {
			error:
				parsed.error === "whole-number"
					? "enter a whole number of tokens, or leave it empty for unlimited"
					: parsed.error === "too-large"
						? "that number is too large"
						: "enter at least 1 token, or leave it empty for unlimited",
		};
	}
	if (parsed.quota === 0) return { error: "enter at least 1 token, or leave it empty for unlimited" };
	return parsed;
}

/**
 * Validates the form and shapes the API body. Returns `errors` otherwise; the
 * server still validates the cron expression and the timezone itself, so a
 * well-formed but invalid pair fails only on save/preview.
 */
export function parseScheduleForm(
	state: ScheduleFormState,
): { input: ParsedSchedule } | { errors: ScheduleFormErrors } {
	const errors: ScheduleFormErrors = {};
	const name = state.name.trim();
	if (!name) errors.name = "name is required";
	else if (name.length > 200) errors.name = "name must be at most 200 characters";
	const prompt = state.prompt;
	if (!prompt.trim()) errors.prompt = "prompt is required";
	if (!state.model) errors.model = "choose a model";
	const budget = parseBudgetInput(state.tokenBudget);
	if ("error" in budget) errors.tokenBudget = budget.error;
	const cron = state.cron.trim();
	if (!cron) errors.cron = "a cron expression is required";
	else if (cron.split(/\s+/).length !== 5) errors.cron = "a cron expression has exactly five fields";
	const timezone = state.timezone.trim();
	if (!timezone) errors.timezone = "a timezone is required";
	if (Object.keys(errors).length > 0 || !state.model || "error" in budget) return { errors };
	return {
		input: {
			name,
			prompt,
			model: state.model,
			preset: state.preset,
			tokenBudget: budget.quota,
			cron,
			timezone,
			catchUp: state.catchUp,
			enabled: state.enabled,
		},
	};
}

/** What the schedule's "last result" cell shows: the running instance wins over the last finished one. */
export type ScheduleStateLabel = ScheduleRunStatus | "never";

export function scheduleState(schedule: Pick<ScheduleView, "inProgress" | "lastRun">): ScheduleStateLabel {
	if (schedule.inProgress) return "running";
	return schedule.lastRun?.status ?? "never";
}

/** The warning the preset deserves on a schedule (doc/scheduling.md#授权规则与配额). */
export function presetNoteKey(preset: Preset): "ask" | "auto_review" | "yolo" {
	return preset;
}

/** The keys a run note is built from: a reason, the manual flag and how it ended. */
export function runNoteParts(run: ScheduleRunView): {
	status: ScheduleRunStatus;
	reason: string | null;
	manual: boolean;
} {
	return { status: run.status, reason: run.reason, manual: run.manual };
}
