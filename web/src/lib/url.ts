/**
 * URL policy: only `http:`, `https:` and `mailto:` survive.
 *
 * Agent output is untrusted, so the check is deliberately paranoid:
 *  - strip ASCII whitespace and control characters (browsers drop tabs/newlines
 *    inside URLs, so `java\tscript:` still navigates);
 *  - compare the scheme case-insensitively;
 *  - anything without a scheme (relative, anchor, protocol-relative) is rejected
 *    too, because "http(s)/mailto only" is the policy.
 *
 * Markdown URLs arrive already decoded by react-markdown (it decodes character
 * references while parsing, before calling `urlTransform`), so decoding again
 * here would alter a URL that legitimately contains the text `&amp;`.
 */

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export interface UrlVerdict {
	allowed: boolean;
	/** URL to put in the DOM when allowed (trimmed). */
	url: string;
	scheme: string | null;
}

export function inspectUrl(raw: unknown): UrlVerdict {
	if (typeof raw !== "string" || raw.length === 0) return { allowed: false, url: "", scheme: null };

	// Remove C0 controls and DEL everywhere: browsers ignore them inside URLs, so
	// they must not be able to split a scheme (`java\tscript:`).
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point (browsers strip them from URLs).
	const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "");
	// Trim ASCII whitespace / NBSP at both ends only. Inner spaces make the URL
	// relative in every browser we care about, which is rejected below.
	const trimmed = cleaned.replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
	if (trimmed.length === 0) return { allowed: false, url: "", scheme: null };

	const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
	if (!match) return { allowed: false, url: trimmed, scheme: null };

	const scheme = `${(match[1] as string).toLowerCase()}:`;
	return { allowed: ALLOWED_SCHEMES.has(scheme), url: trimmed, scheme };
}

/**
 * `react-markdown`-compatible `urlTransform`. Returns the URL to render, or an
 * empty string when the link must be dropped. `react-markdown` also drops
 * empty-href anchors itself, but the components render through `inspectUrl`
 * as well, so this is defence in depth.
 */
export function safeUrlTransform(url: string): string {
	const verdict = inspectUrl(url);
	return verdict.allowed ? verdict.url : "";
}

/**
 * A server-generated WebUI path (the event stream's `approval_url` /
 * `authorization_url`, doc/design/webui.md "Links"). Only same-origin absolute paths
 * are accepted: no scheme, no protocol-relative form, no backslash, no
 * whitespace or control characters, and no dot segments that would climb out
 * of the route. Anything else is not turned into a clickable link.
 */
export function safeInternalPath(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const path = raw.trim();
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return undefined;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\u0000-\u0020\u007f]/.test(path)) return undefined;
	if (/(^|\/)\.\.?(\/|$)/.test(path.split(/[?#]/)[0] ?? "")) return undefined;
	return path;
}
