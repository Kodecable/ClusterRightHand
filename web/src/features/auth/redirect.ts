/**
 * A redirect target from the login page must stay inside this app: a path on
 * this origin, never `//host`, never an absolute URL. This keeps the
 * "deep link survives login" behaviour from becoming an open redirect.
 */
export function safeRedirectPath(value: string | undefined | null): string | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	if (!value.startsWith("/") || value.startsWith("//")) return undefined;
	// Backslashes are normalised to slashes by some browsers; reject them too.
	if (value.includes("\\")) return undefined;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
	if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
	return value;
}
