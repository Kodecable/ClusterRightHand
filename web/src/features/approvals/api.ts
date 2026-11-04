import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNodeGroups } from "@/features/node-groups/api";
import { taskKeys } from "@/features/tasks/api";
import { enc, http } from "@/lib/api/client";
import type { ApiTokenView, ApprovalBody, ApprovalList, PublicNode, TaskGroupView, TaskView } from "@/lib/api/types";

export const approvalKeys = {
	all: ["approvals"] as const,
	list: () => ["approvals", "list"] as const,
};

/**
 * Refreshes what a decision, a signature or a cancel changes: the approvals
 * list behind the sidebar badge and the Approvals page (it carries the pending
 * signatures too) and the tasks and task groups those cards show.
 */
export function invalidatePendingDecisions(queryClient: QueryClient): void {
	void queryClient.invalidateQueries({ queryKey: approvalKeys.all });
	void queryClient.invalidateQueries({ queryKey: taskKeys.all });
}

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

/** The name lookups the approval cards display nodes, node groups and tokens with. */
export function useApprovalLookups() {
	const nodes = useQuery({
		queryKey: ["nodes", "list"],
		queryFn: ({ signal }) => http.get<{ nodes: PublicNode[] }>("/nodes", { signal }).then((r) => r.nodes),
	});
	const nodeGroups = useNodeGroups();
	const tokens = useQuery({
		queryKey: ["api-tokens", "list"],
		queryFn: ({ signal }) => http.get<{ tokens: ApiTokenView[] }>("/api-tokens", { signal }).then((r) => r.tokens),
	});
	const nodeNames = new Map((nodes.data ?? []).map((node) => [node.id, node.name]));
	const nodeGroupNames = new Map((nodeGroups.data ?? []).map((group) => [group.id, group.name]));
	return {
		nodeNames,
		refNames: new Map([...nodeNames, ...nodeGroupNames]),
		tokenNames: new Map((tokens.data ?? []).map((token) => [token.id, token.name])),
	};
}

export interface DecideInput {
	kind: "task" | "task_group";
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
		onSuccess: () => {
			invalidatePendingDecisions(queryClient);
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

export function useApprovalTaskGroup(id: string | undefined) {
	return useQuery({
		queryKey: taskKeys.taskGroup(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ taskGroup: TaskGroupView }>(`/task-groups/${enc(id ?? "")}`, { signal }).then((r) => r.taskGroup),
	});
}
