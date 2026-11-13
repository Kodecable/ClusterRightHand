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

/** The structured image of a `view_image` result (doc/design/library.md "view_image"). */
export interface ViewImageDetails {
	sha256: string;
	mime: string;
	width: number;
	height: number;
	bytes: number;
	source: { library: string; path: string } | { node: string; path: string };
}

export function viewImageDetails(details: Json | undefined): ViewImageDetails | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const image = details.image;
	if (typeof image !== "object" || image === null || Array.isArray(image)) return undefined;
	const record = image as Record<string, unknown>;
	if (
		typeof record.sha256 !== "string" ||
		typeof record.mime !== "string" ||
		typeof record.width !== "number" ||
		typeof record.height !== "number" ||
		typeof record.bytes !== "number"
	) {
		return undefined;
	}
	const source = record.source;
	if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
	const where = source as Record<string, unknown>;
	if (typeof where.path !== "string") return undefined;
	if (typeof where.library === "string") {
		return {
			sha256: record.sha256,
			mime: record.mime,
			width: record.width,
			height: record.height,
			bytes: record.bytes,
			source: { library: where.library, path: where.path },
		};
	}
	if (typeof where.node === "string") {
		return {
			sha256: record.sha256,
			mime: record.mime,
			width: record.width,
			height: record.height,
			bytes: record.bytes,
			source: { node: where.node, path: where.path },
		};
	}
	return undefined;
}
