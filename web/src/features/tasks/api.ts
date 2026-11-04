import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http, queryString } from "@/lib/api/client";
import { useCursorInfiniteQuery } from "@/lib/api/query";
import type { CursorPage, CursorQuery, TaskGroupView, TaskRequest, TaskView } from "@/lib/api/types";
import { isTerminal } from "./output";

/**
 * How long one `wait` request may hang before it answers with the current view.
 * A terminal task ends the wait at once; the timeout only bounds how stale an
 * intermediate state (a new approval, a running task) can look.
 */
const WAIT_TIMEOUT_MS = 5_000;
/** Pause between two waits while the task is still open. */
const WAIT_GAP_MS = 250;

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
	taskGroup: (id: string) => ["tasks", "task-group", id] as const,
	taskGroupAuthorization: (id: string) => ["tasks", "task-group-authorization", id] as const,
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

/**
 * One task. The first read is a plain `GET` (a wait on a task that already
 * waits for an approval would not answer until that wait ends); once the task
 * is on screen and still open, the query refetches `GET /tasks/:id/wait` so a
 * result shows up the moment it exists instead of up to a poll interval later.
 * The wait request is part of the query function, so React Query aborts it on
 * unmount; a timeout is followed by the next wait.
 */
export function useTask(id: string | undefined, pollWaiting = false) {
	return useQuery({
		queryKey: taskKeys.detail(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal, client, queryKey }) => {
			const path = `/tasks/${enc(id ?? "")}`;
			const known = client.getQueryData(queryKey) !== undefined;
			if (!pollWaiting || !known) return http.get<{ task: TaskView }>(path, { signal }).then((r) => r.task);
			return http
				.get<{ task: TaskView }>(`${path}/wait${queryString({ timeoutMs: WAIT_TIMEOUT_MS })}`, { signal })
				.then((r) => r.task);
		},
		refetchInterval: (query) => {
			if (!pollWaiting) return false;
			const state = query.state.data?.state;
			return state !== undefined && !isTerminal(state) ? WAIT_GAP_MS : false;
		},
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
		// The run panel shows the failure above its Run button.
		meta: { toast: false },
	});
}

export function useCancelTask(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => http.post<{ cancelled: boolean }>(`/tasks/${enc(id)}/cancel`),
		onSuccess: () => {
			// The task's own view and every list that shows it (and its task group).
			void queryClient.invalidateQueries({ queryKey: taskKeys.all });
		},
	});
}

const GROUP_ENDED = new Set(["finished", "interrupted", "rejected"]);

/**
 * A task group that will not change any more. A tool card whose task group ended stops following it, and its wait
 * returns the current view instead of long-polling (doc/webui.md "工具卡片").
 */
export function taskGroupEnded(state: string): boolean {
	return GROUP_ENDED.has(state);
}

/** One task group: as `useTask`, with `GET /task-groups/:id/wait` for the open task group. */
export function useTaskGroup(id: string | undefined, pollRunning = false) {
	return useQuery({
		queryKey: taskKeys.taskGroup(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal, client, queryKey }) => {
			const path = `/task-groups/${enc(id ?? "")}`;
			const known = client.getQueryData(queryKey) !== undefined;
			if (!pollRunning || !known)
				return http.get<{ taskGroup: TaskGroupView }>(path, { signal }).then((r) => r.taskGroup);
			return http
				.get<{ taskGroup: TaskGroupView }>(`${path}/wait${queryString({ timeoutMs: WAIT_TIMEOUT_MS })}`, { signal })
				.then((r) => r.taskGroup);
		},
		refetchInterval: (query) => {
			if (!pollRunning) return false;
			const state = query.state.data?.state;
			return state !== undefined && !taskGroupEnded(state) ? WAIT_GAP_MS : false;
		},
	});
}
