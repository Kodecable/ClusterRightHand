import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { taskKeys } from "@/features/tasks/api";
import { enc, http } from "@/lib/api/client";
import type { ApiTokenView, ApprovalBody, ApprovalList, PublicNode, TaskGroupView, TaskView } from "@/lib/api/types";

export const approvalKeys = {
	all: ["approvals"] as const,
	list: () => ["approvals", "list"] as const,
};

const POLL_MS = 10_000;

/**
 * The approvals the badge and the approvals page count (doc/webui.md "外壳").
 * Refetched every 10 s; every decision mutation invalidates it immediately.
 */
export function useApprovals() {
	return useQuery({
		queryKey: approvalKeys.list(),
		queryFn: ({ signal }) => http.get<ApprovalList>("/approvals", { signal }),
		refetchInterval: POLL_MS,
	});
}

/** The two lookup maps the approval cards display node and token names with. */
export function useApprovalLookups() {
	const nodes = useQuery({
		queryKey: ["nodes", "list"],
		queryFn: ({ signal }) => http.get<{ nodes: PublicNode[] }>("/nodes", { signal }).then((r) => r.nodes),
	});
	const tokens = useQuery({
		queryKey: ["api-tokens", "list"],
		queryFn: ({ signal }) => http.get<{ tokens: ApiTokenView[] }>("/api-tokens", { signal }).then((r) => r.tokens),
	});
	return {
		nodeNames: new Map((nodes.data ?? []).map((node) => [node.id, node.name])),
		tokenNames: new Map((tokens.data ?? []).map((token) => [token.id, token.name])),
	};
}

export interface DecideInput {
	kind: "task" | "group";
	id: string;
	body: ApprovalBody;
}

/** Approve or reject a waiting task or task group (the approvals page and the decision cards). */
export function useDecideApproval() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ kind, id, body }: DecideInput) =>
			kind === "task"
				? http.post<{ ok: true }>(`/tasks/${enc(id)}/approval`, body)
				: http.post<{ ok: true }>(`/task-groups/${enc(id)}/approval`, body),
		onSuccess: (_result, variables) => {
			void queryClient.invalidateQueries({ queryKey: approvalKeys.all });
			void queryClient.invalidateQueries({ queryKey: taskKeys.all });
			if (variables.kind === "task") {
				void queryClient.invalidateQueries({ queryKey: taskKeys.detail(variables.id) });
			} else {
				void queryClient.invalidateQueries({ queryKey: taskKeys.group(variables.id) });
			}
		},
		onError: (error) => {
			// 409 means someone else decided first: refresh so the card shows it.
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
		queryFn: ({ signal }) => http.get<{ task: TaskView }>(`/tasks/${enc(id ?? "")}`, { signal }).then((r) => r.task),
	});
}

export function useApprovalGroup(id: string | undefined) {
	return useQuery({
		queryKey: taskKeys.group(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ group: TaskGroupView }>(`/task-groups/${enc(id ?? "")}`, { signal }).then((r) => r.group),
	});
}
