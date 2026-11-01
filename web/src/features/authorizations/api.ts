import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidatePendingDecisions } from "@/features/approvals/api";
import { enc, http, queryString } from "@/lib/api/client";
import { useCursorInfiniteQuery } from "@/lib/api/query";
import type {
	AuthorizationSummary,
	CursorPage,
	GroupPending,
	GroupPendingTask,
	PendingAuthorization,
	TaskGroupView,
} from "@/lib/api/types";

export const authorizationKeys = {
	all: ["authorizations"] as const,
	list: () => ["authorizations", "list"] as const,
	listPage: (filters: AuthorizationFilters) => ["authorizations", "list", filters] as const,
	pending: (kind: "task" | "group", id: string) => ["authorizations", "pending", kind, id] as const,
};

export interface AuthorizationFilters {
	cursor?: string;
	limit?: number;
}

export function useAuthorizations(filters: AuthorizationFilters = {}) {
	return useCursorInfiniteQuery<AuthorizationSummary>({
		queryKey: authorizationKeys.listPage(filters),
		fetchPage: (cursor, signal) =>
			http.get<CursorPage<AuthorizationSummary>>(`/authorizations${queryString({ cursor, limit: filters.limit })}`, {
				signal,
			}),
	});
}

/** The pending payload of a waiting task or task group, polled while the card is open. */
export function usePendingAuthorization(kind: "task" | "group", id: string | undefined) {
	return useQuery({
		queryKey: authorizationKeys.pending(kind, id ?? ""),
		enabled: id !== undefined && id !== "",
		refetchInterval: 5_000,
		queryFn: async ({ signal }): Promise<{ pending: PendingAuthorization | null; tasks: GroupPendingTask[] }> => {
			if (kind === "task") {
				const result = await http.get<{ authorization: PendingAuthorization | null }>(
					`/tasks/${enc(id ?? "")}/authorization`,
					{ signal },
				);
				return { pending: result.authorization, tasks: [] };
			}
			const result = await http.get<{ group: GroupPending | null }>(`/task-groups/${enc(id ?? "")}/authorization`, {
				signal,
			});
			return { pending: result.group?.authorization ?? null, tasks: result.group?.tasks ?? [] };
		},
	});
}

export type SubmitAuthorizationInput = { authorization: string } | { payloadId: string; webauthn: unknown };

/** Submit the pasted `crha grant` output or a Passkey assertion. */
export function useSubmitAuthorization() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: SubmitAuthorizationInput) =>
			http
				.post<{ authorization: { id: string; dispatched: string[] } }>("/authorizations", input)
				.then((r) => r.authorization),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: authorizationKeys.all });
			// The approvals list carries the pending signatures; signing settles a task.
			invalidatePendingDecisions(queryClient);
		},
		// The authorization card renders the failure beside its paste box.
		meta: { toast: false },
	});
}

export function useRevokeAuthorization() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			http.post<{ authorization: { id: string; revokedAt: string } }>(`/authorizations/${enc(id)}/revoke`),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: authorizationKeys.all });
		},
	});
}

/** The task group's pending-tasks table (the authorization card shows it for groups). */
export type { TaskGroupView };
