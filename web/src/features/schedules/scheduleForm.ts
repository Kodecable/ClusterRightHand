import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ModelRef, RulePreset, ScheduleRunStatus, ScheduleRunView, ScheduleView } from "@/lib/api/types";
import { parseQuotaInput } from "@/lib/quota";

/** Pure form and display helpers for schedules (doc/scheduling.md); the pages only render them. */

export interface ScheduleFormState {
	name: string;
	prompt: string;
	model: ModelRef | undefined;
	rulePreset: RulePreset;
	tokenBudget: string;
	cron: string;
	timezone: string;
	catchUp: boolean;
	enabled: boolean;
}

/**
 * Validation failures as codes, translated by the page with Lingui. The pure
 * helper never produces English sentences.
 */
export type ScheduleFormErrorCode =
	| "name-required"
	| "name-too-long"
	| "prompt-required"
	| "model-required"
	| "budget-whole-number"
	| "budget-too-large"
	| "budget-positive"
	| "cron-required"
	| "cron-five-fields"
	| "timezone-required";

export interface ScheduleFormErrors {
	name?: ScheduleFormErrorCode;
	prompt?: ScheduleFormErrorCode;
	model?: ScheduleFormErrorCode;
	tokenBudget?: ScheduleFormErrorCode;
	cron?: ScheduleFormErrorCode;
	timezone?: ScheduleFormErrorCode;
}

const MESSAGES: Record<ScheduleFormErrorCode, MessageDescriptor> = {
	"name-required": msg`A name is required.`,
	"name-too-long": msg`The name must be at most 200 characters.`,
	"prompt-required": msg`A prompt is required.`,
	"model-required": msg`Choose a model.`,
	"budget-whole-number": msg`Enter a whole number of tokens, or leave it empty for unlimited.`,
	"budget-too-large": msg`That number is too large.`,
	"budget-positive": msg`Enter at least 1 token, or leave it empty for unlimited.`,
	"cron-required": msg`A cron expression is required.`,
	"cron-five-fields": msg`A cron expression has exactly five fields.`,
	"timezone-required": msg`A timezone is required.`,
};

/** The translated text of a schedule form error code. */
export function scheduleFormErrorText(i18n: I18n, code: ScheduleFormErrorCode): string {
	return i18n._(MESSAGES[code]);
}

export interface ParsedSchedule {
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

/** The browser's timezone, used as the form's default; "UTC" when it cannot be determined. */
export function defaultTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** The schedule's budget: empty for unlimited, or at least one token (doc/scheduling.md#授权规则与配额). */
function parseBudgetInput(text: string): { quota: number | null } | { error: ScheduleFormErrorCode } {
	const parsed = parseQuotaInput(text);
	if ("error" in parsed) {
		return {
			error:
				parsed.error === "whole-number"
					? "budget-whole-number"
					: parsed.error === "too-large"
						? "budget-too-large"
						: "budget-positive",
		};
	}
	if (parsed.quota === 0) return { error: "budget-positive" };
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
	if (!name) errors.name = "name-required";
	else if (name.length > 200) errors.name = "name-too-long";
	const prompt = state.prompt;
	if (!prompt.trim()) errors.prompt = "prompt-required";
	if (!state.model) errors.model = "model-required";
	const budget = parseBudgetInput(state.tokenBudget);
	if ("error" in budget) errors.tokenBudget = budget.error;
	const cron = state.cron.trim();
	if (!cron) errors.cron = "cron-required";
	else if (cron.split(/\s+/).length !== 5) errors.cron = "cron-five-fields";
	const timezone = state.timezone.trim();
	if (!timezone) errors.timezone = "timezone-required";
	if (Object.keys(errors).length > 0 || !state.model || "error" in budget) return { errors };
	return {
		input: {
			name,
			prompt,
			model: state.model,
			rulePreset: state.rulePreset,
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

const RUN_STATUS_TEXT: Record<ScheduleRunStatus, MessageDescriptor> = {
	succeeded: msg`finished`,
	failed: msg`failed`,
	preempted: msg`stopped by the next run`,
	running: msg`running`,
	pending: msg`queued`,
};

/** How a run ended, for the history's "note" column. */
export function runStatusText(i18n: I18n, status: ScheduleRunStatus): string {
	return i18n._(RUN_STATUS_TEXT[status]);
}

const RULE_PRESET_NOTES: Partial<Record<RulePreset, MessageDescriptor>> = {
	ask: msg`The Ask rule preset can often pause the schedule while it waits for your confirmation.`,
	yolo: msg`The Yolo rule preset runs every action without asking or checking.`,
};

/** The explanation shown under the rule preset picker, or null when the rule preset needs no callout. */
export function rulePresetNoteText(i18n: I18n, rulePreset: RulePreset): string | null {
	const note = RULE_PRESET_NOTES[rulePreset];
	return note === undefined ? null : i18n._(note);
}

/** The keys a run note is built from: a reason, the manual flag and how it ended. */
export function runNoteParts(run: ScheduleRunView): {
	status: ScheduleRunStatus;
	reason: string | null;
	manual: boolean;
} {
	return { status: run.status, reason: run.reason, manual: run.manual };
}
