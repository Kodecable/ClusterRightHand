/** Runtime schemas for the audit log (`GET /api/audit`, doc/design/access-control.md "Audit"). */
import { z } from "zod";
import { CursorQuerySchema, cursorPageSchema } from "./common.ts";
import { RequestSourceSchema } from "./request-source.ts";

export const AuditEventSchema = z
	.object({
		seq: z.number().describe("Database-assigned order; newer events have larger numbers."),
		id: z.string(),
		ts: z.string(),
		actorType: z.string(),
		actorId: z.string(),
		source: RequestSourceSchema.describe(
			"The actor as a displayable source; a system actor, Auto Review and a schedule keep their own labels here.",
		),
		onBehalfOfUserId: z.string().nullable(),
		action: z.string().describe("A dotted verb such as `node.approved`."),
		targetType: z.string().nullable(),
		targetId: z.string().nullable(),
		detail: z.record(z.string(), z.unknown()),
	})
	.meta({ id: "AuditEvent", description: "One audit event." });

export const AuditListQuerySchema = CursorQuerySchema.extend({
	action: z.string().optional().describe("Only this action; an action that is not a dotted verb matches everything."),
	targetType: z.string().optional(),
	targetId: z.string().optional(),
});

export const AuditListResponseSchema = cursorPageSchema(AuditEventSchema).meta({ id: "AuditListResponse" });
