import type { Context } from "hono";
import type { Audit } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";

export interface AppEnv {
	Variables: { user: SessionUser; audit: Audit };
}

export function jsonError(c: Context, status: 400 | 401 | 403 | 404 | 409 | 429, message: string) {
	return c.json({ error: message }, status);
}

/** Reads a JSON object body; anything else is a 400 handled by the caller. */
export async function readJsonObject(c: Context): Promise<Record<string, unknown> | undefined> {
	try {
		const body: unknown = await c.req.json();
		return typeof body === "object" && body !== null && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
	return value;
}
