/**
 * The one mapping from server status values to the five UI tones.
 *
 * StatusText and StatusDot render a tone; every page asks this module instead
 * of inventing its own colours, so a status means the same thing everywhere
 * (doc/design/webui.md "Shared components").
 */
import type { TaskOutcome } from "@crh/api";

export type StatusTone = "ok" | "warn" | "danger" | "info" | "muted";

/** Node status: pending enrollment is a warning, an active node is ok. */
export function nodeStatusTone(status: string): StatusTone {
	switch (status) {
		case "active":
			return "ok";
		case "pending":
			return "warn";
		default:
			return "muted";
	}
}

/**
 * Task status. A terminal status takes its tone from the server's outcome, so an exit code that failed
 * is not shown green beside a red outcome. The state text still reads Finished for `exited`.
 */
export function taskStatusTone(state: string, outcome?: TaskOutcome | null): StatusTone {
	if (outcome !== null && outcome !== undefined) {
		if (outcome.failed) return "danger";
		return outcome.kind === "cancelled" ? "muted" : "ok";
	}
	switch (state) {
		case "exited":
			return "ok";
		case "awaiting_approval":
		case "awaiting_authorization":
		case "running":
		case "dispatched":
			return "info";
		case "failed":
		case "denied":
		case "rejected":
		case "unknown":
			return "danger";
		case "cancelled":
			return "muted";
		default:
			return "muted";
	}
}

/**
 * Task groups use the task tones for the states they share: waiting is
 * informational like a waiting task, running is informational, cancelled is
 * muted like a cancelled task, and only rejected/interrupted are dangerous.
 */
export function taskGroupStatusTone(state: string, outcome?: TaskOutcome | null): StatusTone {
	if (outcome !== null && outcome !== undefined) {
		if (outcome.failed) return "danger";
		return outcome.kind === "cancelled" ? "muted" : "ok";
	}
	switch (state) {
		case "finished":
			return "ok";
		case "running":
			return "info";
		case "rejected":
		case "interrupted":
			return "danger";
		case "awaiting_approval":
		case "awaiting_authorization":
			return taskStatusTone(state);
		case "cancelled":
			return taskStatusTone("cancelled");
		default:
			return "muted";
	}
}

/**
 * External tool calls: waiting and running are informational; succeeded is ok; failed, rejected and unknown
 * are dangerous; cancelled is muted.
 */
export function externalCallStatusTone(state: string): StatusTone {
	switch (state) {
		case "succeeded":
			return "ok";
		case "awaiting_approval":
		case "running":
			return "info";
		case "failed":
		case "rejected":
		case "unknown":
			return "danger";
		case "cancelled":
			return "muted";
		default:
			return "muted";
	}
}

/** One level's own or effective rule result, as the approval card shows it. */
export function ruleResultTone(result: string): StatusTone {
	switch (result) {
		case "allow":
			return "ok";
		case "deny":
			return "danger";
		case "require-approval":
			return "warn";
		default:
			return "muted";
	}
}

/** The contract's raw `sessions.state` mapped to the three UI states, without guessing. */
export type SessionUiState = "idle" | "running" | "awaiting";

export function sessionUiState(rawState: string): SessionUiState {
	switch (rawState) {
		case "awaiting":
			return "awaiting";
		case "running":
			return "running";
		default:
			return "idle";
	}
}

export function sessionStatusTone(rawState: string): StatusTone {
	switch (sessionUiState(rawState)) {
		case "awaiting":
			return "warn";
		case "running":
			return "info";
		default:
			return "muted";
	}
}

/** A schedule's last run / current run. */
export function scheduleStatusTone(status: string): StatusTone {
	switch (status) {
		case "succeeded":
			return "ok";
		case "running":
			return "info";
		case "preempted":
		case "pending":
			return "warn";
		case "failed":
			return "danger";
		default:
			return "muted";
	}
}

/** API tokens: active, expired, revoked. */
export function tokenStatusTone(status: string): StatusTone {
	switch (status) {
		case "active":
			return "ok";
		case "expired":
			return "warn";
		case "revoked":
			return "danger";
		default:
			return "muted";
	}
}
