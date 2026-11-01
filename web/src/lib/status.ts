/**
 * The one mapping from server status values to the five UI tones.
 *
 * StatusBadge and StatusDot render a tone; every page asks this module instead
 * of inventing its own colours, so a status means the same thing everywhere
 * (doc/webui.md "共享部件").
 */

export type StatusTone = "ok" | "warn" | "danger" | "info" | "muted";

/** Node status: pending enrollment is a warning, disabled is muted. */
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

/** Task status; a non-zero exit is the command's own failure (warn), not the platform's (danger). */
export function taskStatusTone(
	state: string,
	exitCode: number | null = null,
	signal: string | null = null,
): StatusTone {
	switch (state) {
		case "exited":
			return exitCode === 0 && signal === null ? "ok" : "warn";
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

/** Authorization states shown on the authorizations page and in the waiting card. */
export function authorizationStatusTone(status: string): StatusTone {
	switch (status) {
		case "active":
		case "issued":
		case "signed":
			return "ok";
		case "pending":
		case "awaiting":
			return "warn";
		case "revoked":
		case "expired":
		case "rejected":
		case "dead":
			return "danger";
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
