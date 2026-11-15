/**
 * URLs in audit details and status errors: an MCP endpoint can carry a credential in its query, fragment or
 * userinfo (doc/design/extensions.md "Extensions"), so only the scheme, host and path are kept.
 */

/** A URL without userinfo, query or fragment. */
export function urlWithoutSecrets(raw: string): string {
	try {
		const url = new URL(raw);
		return `${url.origin}${url.pathname}`;
	} catch {
		return raw.replace(/\/\/[^/]*@/, "//").replace(/[?#].*$/, "");
	}
}

/** Removes the userinfo, query and fragment of every absolute http(s) URL in a message. */
export function redactUrlsInText(text: string): string {
	return text.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => urlWithoutSecrets(match));
}
