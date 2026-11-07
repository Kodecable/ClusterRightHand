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
