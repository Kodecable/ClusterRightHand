import type { Context } from "hono";
import type { Audit } from "../audit/audit.ts";
import type { SessionActorOverride, SessionUser } from "../auth/sessions.ts";
import { UserError } from "../util/errors.ts";

/**
 * The identity an in-process `api_request` carries in the request's bindings (doc/design/extensions.md
 * "API requests"). It is not derived from any header, so a network request cannot set it.
 */
export interface InternalRequestIdentity {
	/** The session owner the request runs as. */
	userId: string;
	/** The audit actor: the agent session or subagent, on behalf of the owner. */
	actor: SessionActorOverride;
}

export interface AppEnv {
	Variables: { user: SessionUser; audit: Audit };
	Bindings: { crhInternal?: InternalRequestIdentity };
}

export interface JsonErrorOptions {
	/** A stable snake_case code clients may branch on; omitted when the message alone is enough. */
	code?: string;
	headers?: Record<string, string>;
}

export function jsonError(
	c: Context,
	status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503,
	message: string,
	options: JsonErrorOptions = {},
) {
	for (const [name, value] of Object.entries(options.headers ?? {})) c.header(name, value);
	return c.json({ error: message, ...(options.code === undefined ? {} : { code: options.code }) }, status);
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

/** A field that may be absent but must be a string when present; a wrong type is a 400 by UserError. */
export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new UserError(`${key} must be a string`);
	return value;
}
