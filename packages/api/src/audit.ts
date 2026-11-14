/**
 * The audit log (`GET /api/audit`).
 */

import type { z } from "zod";
import type { CursorQuery } from "./common.ts";
import type { AuditEventSchema } from "./schemas/audit.ts";

/** One audit event. */
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export interface AuditQuery extends CursorQuery {
	action?: string;
	targetType?: string;
	targetId?: string;
}
