import type {
	ApiTokenView,
	ApprovalBody,
	ApprovalList,
	ApprovalRequest,
	ExternalCallView,
	TaskGroupView,
	TaskView,
} from "@crh/api";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNodeGroups } from "@/features/node-groups/api";
import { useNodeNames } from "@/features/nodes/api";
import { type TaskDetailView, type TaskGroupDetailView, taskKeys } from "@/features/tasks/api";
import { useUserNames } from "@/features/users/api";
import { enc, http } from "@/lib/api/client";

export const approvalKeys = {
	all: ["approvals"] as const,
	list: () => ["approvals", "list"] as const,
};

/**
 * Refreshes what a decision, a signature or a cancel changes: the approvals
 * list behind the sidebar badge and the Approvals page (it carries the pending
 * signatures too) and the tasks and task groups those decisions show.
 */
export function invalidatePendingDecisions(queryClient: QueryClient): void {
	void queryClient.invalidateQueries({ queryKey: approvalKeys.all });
	void queryClient.invalidateQueries({ queryKey: taskKeys.all });
}

const POLL_MS = 10_000;
/** A direct approval page follows a request Auto Review is still judging, until a verdict arrives. */
const REVIEW_POLL_MS = 3_000;

/**
 * The approvals the badge and the approvals page count (doc/design/webui.md "Approvals page").
 * Refetched every 10 s; every decision mutation invalidates it immediately.
 */
export function useApprovals() {
	return useQuery({
		queryKey: approvalKeys.list(),
		queryFn: ({ signal }) => http.get<ApprovalList>("/approvals", { signal }),
		refetchInterval: POLL_MS,
	});
}

/** The name lookups the decision components display nodes, node groups and tokens with. */
export function useApprovalLookups() {
	const nodeNames = useNodeNames();
	const nodeGroups = useNodeGroups();
	const tokens = useQuery({
		queryKey: ["api-tokens", "list"],
		queryFn: ({ signal }) => http.get<{ tokens: ApiTokenView[] }>("/api-tokens", { signal }).then((r) => r.tokens),
	});
	const userNames = useUserNames();
	const nodeGroupNames = new Map((nodeGroups.data ?? []).map((group) => [group.id, group.name]));
	return {
		nodeNames,
		refNames: new Map([...nodeNames, ...nodeGroupNames]),
		tokenNames: new Map((tokens.data ?? []).map((token) => [token.id, token.name])),
		userNames,
	};
}

export interface DecideInput {
	kind: "task" | "task_group";
	id: string;
	body: ApprovalBody;
}

/** Approve or reject one waiting external call; "always allow" carries a rule. */
export function useDecideExternalCall() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, body }: { id: string; body: ApprovalBody }) =>
			http.post<{ ok: true }>(`/external-calls/${enc(id)}/approval`, body),
		onSuccess: () => invalidatePendingDecisions(queryClient),
		onError: (error) => {
			if (typeof error === "object" && error !== null && "status" in error && error.status === 409) {
				void queryClient.invalidateQueries({ queryKey: approvalKeys.all });
			}
		},
	});
}

/**
 * One external call for its approval page. The compact request rides on the view while the call waits, as
 * it does for tasks, so the page renders the same panel from the server's model.
 */
export type ExternalCallDetailView = ExternalCallView & { request?: ApprovalRequest | null };

export function useExternalCall(id: string | undefined) {
	return useQuery({
		queryKey: ["external-calls", id ?? ""],
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http
				.get<{ externalCall: ExternalCallView; request?: ApprovalRequest | null }>(`/external-calls/${enc(id ?? "")}`, {
					signal,
				})
				.then((r): ExternalCallDetailView => ({ ...r.externalCall, request: r.request ?? null })),
		// The direct page opens while Auto Review decides: follow the phase until the request is the user's.
		refetchInterval: (query) => (query.state.data?.phase === "reviewing" ? REVIEW_POLL_MS : false),
	});
}

/** Approve or reject a waiting task or task group (every decision component shares it). */
export function useDecideApproval() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ kind, id, body }: DecideInput) =>
			kind === "task"
				? http.post<{ ok: true }>(`/tasks/${enc(id)}/approval`, body)
				: http.post<{ ok: true }>(`/task-groups/${enc(id)}/approval`, body),
		onSuccess: () => {
			invalidatePendingDecisions(queryClient);
		},
		onError: (error) => {
			// 409 means someone else decided first: refresh so the decision reflects it.
			if (typeof error === "object" && error !== null && "status" in error && error.status === 409) {
				void queryClient.invalidateQueries({ queryKey: approvalKeys.all });
			}
		},
	});
}

export function useApprovalTask(id: string | undefined) {
	return useQuery({
		queryKey: taskKeys.detail(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http
				.get<{ task: TaskView; request?: ApprovalRequest | null }>(`/tasks/${enc(id ?? "")}`, { signal })
				.then((r): TaskDetailView => ({ ...r.task, request: r.request ?? null })),
		refetchInterval: (query) => (query.state.data?.phase === "reviewing" ? REVIEW_POLL_MS : false),
	});
}

export function useApprovalTaskGroup(id: string | undefined) {
	return useQuery({
		queryKey: taskKeys.taskGroup(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http
				.get<{ taskGroup: TaskGroupView; request?: ApprovalRequest | null }>(`/task-groups/${enc(id ?? "")}`, {
					signal,
				})
				.then((r): TaskGroupDetailView => ({ ...r.taskGroup, request: r.request ?? null })),
		refetchInterval: (query) => (query.state.data?.phase === "reviewing" ? REVIEW_POLL_MS : false),
	});
}
