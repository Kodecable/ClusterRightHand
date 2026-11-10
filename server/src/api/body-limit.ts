import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, jsonError } from "./context.ts";

/** The body limit of ordinary JSON routes: enough for a page of text or a provider's configuration. */
export const DEFAULT_BODY_LIMIT = 1 * 1024 * 1024;

/** The largest input a task may carry: exec stdin or file.write content (doc/design/execution.md "Reconnect"). */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** The longest base64 string that can decode to MAX_INPUT_BYTES. */
export const MAX_INPUT_BASE64_LENGTH = Math.ceil(MAX_INPUT_BYTES / 3) * 4;

/**
 * The body limit of the routes that carry a task's input: the base64 form of the largest input, plus
 * 64 KiB for the rest of the JSON object.
 */
export const MAX_INPUT_BODY_BYTES = MAX_INPUT_BASE64_LENGTH + 64 * 1024;

/** A body over `maxSize` is answered with the API's usual JSON error, a 413. */
export function jsonBodyLimit(maxSize: number): MiddlewareHandler<AppEnv> {
	return bodyLimit({
		maxSize,
		onError: (c) => jsonError(c, 413, "request body too large"),
	}) as MiddlewareHandler<AppEnv>;
}

/**
 * The routes whose own limit is larger than the default: task input routes, and /mcp, whose tools carry
 * the same stdin and file content. The default limit must not run for them, or it would reject a large
 * body before their own limit saw it.
 */
export function takesLargeBody(path: string): boolean {
	return path === "/mcp" || path === "/api/task-groups" || /^\/api\/nodes\/[^/]+\/tasks\/?$/.test(path);
}
