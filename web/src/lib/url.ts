/**
 * URL policy: only `http:`, `https:` and `mailto:` survive.
 *
 * Agent output is untrusted, so the check is deliberately paranoid:
 *  - decode HTML/XML character references before looking at the scheme
 *    (`jav&#x61;script:` and `jav&#97;script:` are javascript: once decoded);
 *  - strip ASCII whitespace and control characters (browsers drop tabs/newlines
 *    inside URLs, so `java\tscript:` still navigates);
 *  - compare the scheme case-insensitively;
 *  - anything without a scheme (relative, anchor, protocol-relative) is rejected
 *    too, because "http(s)/mailto only" is the policy.
 */

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

const NAMED_ENTITIES: Record<string, string> = {
	colon: ":",
	tab: "\t",
	newline: "\n",
	newLine: "\n",
	amp: "&",
	sol: "/",
	bsol: "\\",
	lpar: "(",
	rpar: ")",
	period: ".",
	percnt: "%",
	num: "#",
};

function codePointToString(codePoint: number): string {
	if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
	try {
		return String.fromCodePoint(codePoint);
	} catch {
		return "";
	}
}

/** Decode numeric and the handful of named references that can appear in a scheme. */
export function decodeCharacterReferences(input: string): string {
	return input
		.replace(/&#[xX]([0-9a-fA-F]{1,6});?/g, (_match, hex: string) => codePointToString(Number.parseInt(hex, 16)))
		.replace(/&#([0-9]{1,7});?/g, (_match, decimal: string) => codePointToString(Number.parseInt(decimal, 10)))
		.replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, name: string) => {
			const hit = NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()];
			return hit ?? match;
		});
}

export interface UrlVerdict {
	allowed: boolean;
	/** URL to put in the DOM when allowed (trimmed, character references decoded). */
	url: string;
	scheme: string | null;
}

export function inspectUrl(raw: unknown): UrlVerdict {
	if (typeof raw !== "string" || raw.length === 0) return { allowed: false, url: "", scheme: null };

	const decoded = decodeCharacterReferences(raw);
	// Remove C0 controls and DEL everywhere: browsers ignore them inside URLs, so
	// they must not be able to split a scheme (`java\tscript:`).
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point (browsers strip them from URLs).
	const cleaned = decoded.replace(/[\u0000-\u001f\u007f]/g, "");
	// Trim ASCII whitespace / NBSP at both ends only. Inner spaces make the URL
	// relative in every browser we care about, which is rejected below.
	const trimmed = cleaned.replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
	if (trimmed.length === 0) return { allowed: false, url: "", scheme: null };

	const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
	if (!match) return { allowed: false, url: trimmed, scheme: null };

	const scheme = `${(match[1] as string).toLowerCase()}:`;
	return { allowed: ALLOWED_SCHEMES.has(scheme), url: trimmed, scheme };
}

export function isSafeUrl(raw: unknown): boolean {
	return inspectUrl(raw).allowed;
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

/** Same-origin `#/...` hash links in old agent output; anything else is not linked. */
export function safeHashLink(url: string): string | undefined {
	const hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
	if (!/^#\/[\w\-/.@%+~]*$/.test(hash)) return undefined;
	// A dot segment would navigate elsewhere in the app; the link is not trusted.
	const segments = hash.slice(2).split("/");
	if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
	return hash;
}

/**
 * A server-generated WebUI path (the event stream's `approval_url` /
 * `authorization_url`, doc/webui.md "链接"). Only same-origin absolute paths
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
