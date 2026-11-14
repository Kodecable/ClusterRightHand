import { AuditListQuerySchema, AuditListResponseSchema } from "@crh/api/schemas";
import { listAuditEvents } from "../audit/audit.ts";
import type { Db } from "../storage/db.ts";
import { type CursorSpec, cursorRows, decodeCursor, encodeCursor, parseLimit } from "../util/cursor.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

/** `GET /api/audit` pages over `seq desc` (doc/design/webui.md "API conventions"); the id is carried by the shared format. */
const AUDIT_CURSOR: CursorSpec = { columns: [{ name: "seq", type: "number" }], idType: "string" };

const listRoute = defineRoute({
	method: "get",
	path: "/audit",
	tags: ["Audit"],
	summary: "Page through the audit events the caller may see, newest first",
	agent: "allow",
	request: { query: AuditListQuerySchema },
	responses: { 200: { description: "One page of events", ...json(AuditListResponseSchema) } },
});

/** The audit log, as the caller may see it. Expects requireUser. */
export function auditRoutes(db: Db) {
	const app = apiRouter();

	app.openapi(listRoute, async (c) => {
		const q = c.req.valid("query");
		const action = q.action && /^[a-z_.]{1,64}$/.test(q.action) ? q.action : undefined;
		const limit = parseLimit(q.limit);
		const cursor = q.cursor === undefined ? undefined : decodeCursor(q.cursor, AUDIT_CURSOR);
		const page = await cursorRows(
			limit,
			(limitPlusOne) =>
				listAuditEvents(db, c.get("user"), {
					action,
					targetType: q.targetType || undefined,
					targetId: q.targetId || undefined,
					...(cursor ? { before: { seq: Number(cursor.values[0]), id: String(cursor.id) } } : {}),
					limit: limitPlusOne,
				}),
			(event) => encodeCursor([event.seq], event.id),
		);
		return c.json({ items: page.rows, nextCursor: page.nextCursor }, 200);
	});

	return app;
}
