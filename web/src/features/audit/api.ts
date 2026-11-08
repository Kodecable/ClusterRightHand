import type { AuditEvent, AuditQuery, CursorPage } from "@crh/api";
import { http, queryString } from "@/lib/api/client";
import { useCursorInfiniteQuery } from "@/lib/api/query";

export const auditKeys = {
	all: ["audit"] as const,
	list: () => ["audit", "list"] as const,
	listPage: (filters: AuditQuery) =>
		[
			"audit",
			"list",
			{ action: filters.action ?? "", targetType: filters.targetType ?? "", targetId: filters.targetId ?? "" },
		] as const,
};

/** `GET /api/audit` is cursor-paged, ordered by `seq desc` (doc/webui.md "游标列表"). */
export function useAuditEvents(filters: AuditQuery = {}) {
	const { action, targetType, targetId } = filters;
	return useCursorInfiniteQuery<AuditEvent>({
		queryKey: auditKeys.listPage(filters),
		fetchPage: (cursor, signal) =>
			http.get<CursorPage<AuditEvent>>(
				`/audit${queryString({ action, targetType, targetId, cursor, limit: filters.limit })}`,
				{ signal },
			),
	});
}
