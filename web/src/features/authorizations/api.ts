import type {
	AuthorizationSummary,
	CursorPage,
	PendingAuthorization,
	TaskGroupPending,
	TaskGroupPendingTask,
} from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidatePendingDecisions } from "@/features/approvals/api";
import { enc, http, queryString } from "@/lib/api/client";
import { useCursorInfiniteQuery } from "@/lib/api/query";

export const authorizationKeys = {
	all: ["authorizations"] as const,
	list: () => ["authorizations", "list"] as const,
	listPage: (filters: AuthorizationFilters) => ["authorizations", "list", filters] as const,
	pending: (kind: "task" | "task_group", id: string) => ["authorizations", "pending", kind, id] as const,
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

/** The pending payload of a waiting task or task group, polled while the decision is open. */
export function usePendingAuthorization(kind: "task" | "task_group", id: string | undefined) {
	return useQuery({
		queryKey: authorizationKeys.pending(kind, id ?? ""),
		enabled: id !== undefined && id !== "",
		refetchInterval: 5_000,
		queryFn: async ({ signal }): Promise<{ pending: PendingAuthorization | null; tasks: TaskGroupPendingTask[] }> => {
			if (kind === "task") {
				const result = await http.get<{ authorization: PendingAuthorization | null }>(
					`/tasks/${enc(id ?? "")}/authorization`,
					{ signal },
				);
				return { pending: result.authorization, tasks: [] };
			}
			const result = await http.get<{ taskGroup: TaskGroupPending | null }>(
				`/task-groups/${enc(id ?? "")}/authorization`,
				{
					signal,
				},
			);
			return { pending: result.taskGroup?.authorization ?? null, tasks: result.taskGroup?.tasks ?? [] };
		},
	});
}

export type SubmitAuthorizationInput = { authorization: string } | { payloadId: string; webauthn: unknown };

/** The dispatch usually claims the task within this window; refresh once more after it. */
const DISPATCH_REFRESH_MS = 1_000;

/** Submit the pasted `crha grant` output or a Passkey assertion. */
export function useSubmitAuthorization() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: SubmitAuthorizationInput) =>
			http.post<{ authorization: { id: string } }>("/authorizations", input).then((r) => r.authorization),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: authorizationKeys.all });
			// The approvals list carries the pending signatures; signing settles a task.
			invalidatePendingDecisions(queryClient);
			// The dispatch continues after this response and no SSE carries a task's state, so
			// refresh the pending decision and the task views once more after the claim has landed. The
			// existing polls cover anything slower, such as an offline node's grace.
			setTimeout(() => {
				void queryClient.invalidateQueries({ queryKey: authorizationKeys.all });
				invalidatePendingDecisions(queryClient);
			}, DISPATCH_REFRESH_MS);
		},
		// The signature decision renders the failure beside its signing controls.
		meta: { toast: false },
	});
}

export interface RejectAuthorizationInput {
	kind: "task" | "task_group";
	id: string;
	reason?: string;
}

/**
 * The owner declining to sign (doc/design/privilege.md "Waiting for signatures"): the task ends
 * `rejected` with `authorization_rejected` and the reason, or the server's
 * default text. A 409 means the wait already ended, so the lists are refreshed.
 */
export function useRejectAuthorization() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ kind, id, reason }: RejectAuthorizationInput) => {
			const body = reason !== undefined && reason.trim() !== "" ? { reason: reason.trim() } : {};
			return kind === "task"
				? http.post<{ ok: true }>(`/tasks/${enc(id)}/authorization/reject`, body)
				: http.post<{ ok: true }>(`/task-groups/${enc(id)}/authorization/reject`, body);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: authorizationKeys.all });
			invalidatePendingDecisions(queryClient);
		},
		onError: (error) => {
			if (typeof error === "object" && error !== null && "status" in error && error.status === 409) {
				void queryClient.invalidateQueries({ queryKey: authorizationKeys.all });
				invalidatePendingDecisions(queryClient);
			}
		},
		// The signature decision renders the failure in its Reject tab.
		meta: { toast: false },
	});
}
