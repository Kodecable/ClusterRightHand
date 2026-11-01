import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { taskKeys } from "@/features/tasks/api";
import { enc, http } from "@/lib/api/client";
import type { TaskGroupView, TaskRequest } from "@/lib/api/types";

export interface CreateBatchInput extends TaskRequest {
	targets: string[];
	parallel?: number;
	failFast?: boolean;
	/** status or text for an exec batch; omitted for file operations, which keep each node's head. */
	outputMode?: "status" | "text" | "head";
}

/** Batch runs are task groups: one POST, then poll `GET /task-groups/:id/wait`. */
export function useCreateBatch() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: CreateBatchInput) =>
			http.post<{ group: TaskGroupView }>("/task-groups", input).then((r) => r.group),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: taskKeys.all }),
	});
}

export function useBatchGroup(id: string | undefined) {
	return useQuery({
		queryKey: taskKeys.group(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ group: TaskGroupView }>(`/task-groups/${enc(id ?? "")}`, { signal }).then((r) => r.group),
	});
}
