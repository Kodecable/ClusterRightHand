import type { ModelRef, Preset, ScheduleRunStatus, ScheduleRunView, ScheduleView } from "./api.ts";
import { parseQuotaInput } from "./lib.ts";

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
	if ("error" in parsed) return parsed;
	if (parsed.quota === 0) return { error: "enter at least 1 token, or leave it empty for unlimited" };
	return parsed;
}

/**
 * Validates the form and shapes the API body. Returns `errors` otherwise; the server still validates the cron
 * expression and the timezone itself, so a well-formed but invalid pair fails only on save/preview.
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

export function stateBadgeKind(state: ScheduleStateLabel): "ok" | "bad" | "warn" | "off" {
	switch (state) {
		case "succeeded":
			return "ok";
		case "failed":
			return "bad";
		case "preempted":
			return "warn";
		case "running":
			return "warn";
		default:
			return "off";
	}
}

/** The explanatory line under a run: its reason, that it was started by hand, or how it ended. */
export function runNote(run: ScheduleRunView): string {
	const parts = [run.reason ?? statusText(run.status)];
	if (run.manual) parts.push("run by hand");
	return parts.join(" · ");
}

export function statusText(status: ScheduleRunStatus): string {
	switch (status) {
		case "succeeded":
			return "finished";
		case "failed":
			return "failed";
		case "preempted":
			return "stopped by the next run";
		case "running":
			return "running";
		case "pending":
			return "queued";
	}
}

/** The warning the preset deserves on a schedule (doc/scheduling.md#授权规则与配额). */
export function presetNote(preset: Preset): string {
	switch (preset) {
		case "ask":
			return "Ask: every approval waits for you, while the next trigger still ends the run. Unattended runs will be stopped at the next fire if you are not there.";
		case "auto_review":
			return "Auto Review: approvals first go to a review model; anything risky still waits for you, with the same caveat as Ask.";
		case "yolo":
			return "Yolo: everything runs without asking, including privileged tasks allowed by the node's own policy.";
	}
}
