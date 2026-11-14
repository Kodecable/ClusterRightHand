/** Schemas shared by many routes. */
import { z } from "zod";

/** Every error response: a message and, where clients may branch on it, a stable snake_case code. */
export const ErrorResponseSchema = z
	.object({
		error: z.string(),
		code: z.string().optional(),
	})
	.meta({ id: "ErrorResponse" });

export const OkResponseSchema = z.object({ ok: z.literal(true) });

/** The current name of a stored node or node-group reference; null when the object was deleted. */
export const RefTargetSchema = z
	.object({
		kind: z.enum(["node", "node_group"]),
		name: z.string(),
	})
	.meta({ id: "RefTarget" });

/** Display names for stored UUID references, keyed by id; null means the object was deleted. */
export const RefMapSchema = z.record(z.string(), RefTargetSchema.nullable()).meta({ id: "RefMap" });

/** A path parameter holding an object id. */
export const IdParamSchema = z.object({ id: z.string() });

/** The query parameters every cursor list accepts (doc/design/webui.md "API conventions"). */
export const CursorQuerySchema = z.object({
	cursor: z.string().optional().describe("The `nextCursor` of the previous page."),
	limit: z.string().optional().describe("Page size, 1 to 200; 50 by default."),
});

/** A cursor page of `item`. */
export function cursorPageSchema<T extends z.ZodType>(item: T) {
	return z.object({
		items: z.array(item),
		nextCursor: z.string().nullable().describe("Pass as `cursor` for the next page; null on the last one."),
	});
}

/** Query parameters of the searchable entity lists (doc/design/webui.md "Entity search"), as strings. */
export const EntityListQuerySchema = z.object({
	q: z.string().optional().describe("Case-insensitive substring match; prefix matches come first."),
	limit: z.string().optional().describe("Page size, 1 to 100; with it the response carries `more`."),
	ids: z.string().optional().describe("Comma-separated ids; cannot be combined with `q` or `limit`."),
});

/** A binary request or response body, streamed as its own content type. */
export const BinaryBodySchema = z
	.string()
	.meta({ format: "binary", description: "The raw bytes, streamed as the route's content type." });

/** A server-sent event stream (`text/event-stream`). */
export const EventStreamBodySchema = z
	.string()
	.meta({ format: "binary", description: "Server-sent events, streamed as `text/event-stream`." });

/** `GET /api/health`: the database answered. */
export const HealthResponseSchema = z.object({ status: z.literal("ok") }).meta({ id: "HealthResponse" });
