import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http, queryString } from "@/lib/api/client";
import { useCursorInfiniteQuery } from "@/lib/api/query";
import type { CursorPage, CursorQuery, Operation, TaskGroupView, TaskRequest, TaskView } from "@/lib/api/types";

export const taskKeys = {
	all: ["tasks"] as const,
	list: () => ["tasks", "list"] as const,
	listPage: (filters: TaskFilters) =>
		[
			"tasks",
			"list",
			{ state: filters.state ?? "", actorType: filters.actorType ?? "", nodeId: filters.nodeId ?? "" },
		] as const,
	detail: (id: string) => ["tasks", "detail", id] as const,
	group: (id: string) => ["tasks", "group", id] as const,
	groupAuthorization: (id: string) => ["tasks", "group-authorization", id] as const,
};

export interface TaskFilters extends CursorQuery {
	state?: string;
	actorType?: string;
	nodeId?: string;
}

export function useTasks(filters: TaskFilters = {}) {
	const { state, actorType, nodeId } = filters;
	return useCursorInfiniteQuery<TaskView>({
		queryKey: taskKeys.listPage(filters),
		fetchPage: (cursor, signal) =>
			http.get<CursorPage<TaskView>>(
				`/tasks${queryString({ state, actorType, nodeId, cursor, limit: filters.limit })}`,
				{ signal },
			),
	});
}

export function useTask(id: string | undefined) {
	return useQuery({
		queryKey: taskKeys.detail(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) => http.get<{ task: TaskView }>(`/tasks/${enc(id ?? "")}`, { signal }).then((r) => r.task),
	});
}

export function useCreateTask(nodeId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: TaskRequest) =>
			http.post<{ task: TaskView }>(`/nodes/${enc(nodeId)}/tasks`, body).then((r) => r.task),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: taskKeys.all });
		},
	});
}

export function useCancelTask(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => http.post<{ cancelled: boolean }>(`/tasks/${enc(id)}/cancel`),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: taskKeys.detail(id) });
		},
	});
}

export interface CreateTaskGroupInput extends TaskRequest {
	targets: string[];
	parallel?: number;
	failFast?: boolean;
	outputMode?: "status" | "text";
}

export function useCreateTaskGroup() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: CreateTaskGroupInput) =>
			http.post<{ group: TaskGroupView }>("/task-groups", body).then((r) => r.group),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: taskKeys.all });
		},
	});
}

export function useTaskGroup(id: string | undefined) {
	return useQuery({
		queryKey: taskKeys.group(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ group: TaskGroupView }>(`/task-groups/${enc(id ?? "")}`, { signal }).then((r) => r.group),
	});
}

/** The operation a task reports, used to build an "always allow" rule. */
export function taskOperation(task: TaskView | undefined): Operation | null {
	return task?.operation ?? null;
}
