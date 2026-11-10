import type { Json, JsonObject } from "./session-events";

/** `details.state === "awaiting_approval"` with an approval link, as cluster tools publish while waiting. */
export function approvalWait(details: Json | undefined): { url: string } | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	if (details.state !== "awaiting_approval") return undefined;
	const url = details.approval_url;
	return typeof url === "string" ? { url } : undefined;
}

/**
 * `details.state === "awaiting_authorization"` with the link to the signing page, as cluster tools
 * publish while a privileged task waits for the user's signature (doc/design/privilege.md).
 */
export function authorizationWait(details: Json | undefined): { url: string } | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	if (details.state !== "awaiting_authorization") return undefined;
	const url = details.authorization_url;
	return typeof url === "string" ? { url } : undefined;
}

/** Pretty-prints JSON text; undefined when the text is not a JSON object or array. */
export function prettyJson(text: string): { pretty: string; value: JsonObject | Json[] } | undefined {
	const t = text.trim();
	if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
	try {
		const value = JSON.parse(t) as JsonObject | Json[];
		return { pretty: JSON.stringify(value, null, 2), value };
	} catch {
		return undefined;
	}
}
