/** The message of a thrown value, for wrapping it in another error or a log line. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
