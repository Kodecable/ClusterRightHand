/**
 * The audit log (`GET /api/audit`).
 */

import type { CursorQuery } from "./common.ts";

export interface AuditEvent {
	seq: number;
	id: string;
	ts: string;
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string | null;
	action: string;
	targetType: string | null;
	targetId: string | null;
	detail: Record<string, unknown>;
}

export interface AuditQuery extends CursorQuery {
	action?: string;
	targetType?: string;
	targetId?: string;
}
