import { errorText } from "./errors.ts";

/**
 * Last-resort handling for errors that escaped every catch: crhs is a long-running service, so one missed
 * rejection must not take the process down. The count and the last occurrence are kept so a status view can
 * show that something went wrong even though crhs kept running.
 */

export interface UnexpectedError {
	/** When it was recorded, ISO 8601 UTC. */
	at: string;
	/** The thrown value's message; the error itself, stack included, went to the log. */
	message: string;
}

let count = 0;
let last: UnexpectedError | null = null;
let installed = false;

/** Counts one unexpected error and remembers when it happened and what it was. */
export function recordUnexpectedError(err: unknown): void {
	count += 1;
	last = { at: new Date().toISOString(), message: errorText(err) };
}

/** How many unexpected errors this process has seen. */
export function unexpectedErrorCount(): number {
	return count;
}

/** The most recent unexpected error, or null when there has been none. */
export function lastUnexpectedError(): UnexpectedError | null {
	return last === null ? null : { ...last };
}

/**
 * Registers the process-level last-resort handlers; calling it again is a no-op. The error is logged with its
 * stack and crhs keeps running (main.ts installs these for `serve` only, not for commands that should exit).
 */
export function installProcessErrorHandlers(): void {
	if (installed) return;
	installed = true;
	process.on("unhandledRejection", (err) => {
		recordUnexpectedError(err);
		console.error("crhs: unhandled rejection:", err);
	});
	process.on("uncaughtException", (err) => {
		recordUnexpectedError(err);
		console.error("crhs: uncaught exception:", err);
	});
}
