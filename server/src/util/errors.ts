/** The message of a thrown value, for wrapping it in another error or a log line. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a database error is a unique or primary-key violation. SQLite's message says "UNIQUE constraint
 * failed" and PostgreSQL's says "duplicate key value", with SQLSTATE 23505 on the driver error.
 */
export function isUniqueViolation(err: unknown): boolean {
	if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505")
		return true;
	return /unique|duplicate/i.test(errorText(err));
}

/**
 * An expected refusal, shown to the caller as a tool error (doc/agent-runtime.md#错误结果). `code` is the
 * stable snake_case error code tools use; without one the adapter falls back to `invalid_argument`.
 *
 * It lives in `util/` so policy, cluster and agent code can throw it without importing the user service; the API
 * error handlers still recognise it by class.
 */
export class UserError extends Error {
	readonly code: string | undefined;

	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

/** A missing row or object; a UserError so the API maps it to 404 through the same handler. */
export class NotFoundError extends UserError {}
