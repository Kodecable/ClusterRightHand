import { safeInternalPath } from "@/lib/url";

/**
 * A redirect target from the login page must stay inside this app: a path on
 * this origin, never `//host`, never an absolute URL. It follows the same rule
 * as the server-sent links (`safeInternalPath`), so surrounding whitespace is
 * trimmed and inner whitespace, control characters and dot segments are
 * refused; the login page falls back to its default path when this is
 * undefined. This keeps the "deep link survives login" behaviour from becoming
 * an open redirect.
 */
export function safeRedirectPath(value: string | undefined | null): string | undefined {
	return safeInternalPath(value);
}
