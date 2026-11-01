import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http, queryString } from "@/lib/api/client";
import { useCursorInfiniteQuery } from "@/lib/api/query";
import type { CursorPage, CursorQuery, Operation, TaskGroupView, TaskRequest, TaskView } from "@/lib/api/types";
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
	});
}

export function useCancelTask(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => http.post<{ cancelled: boolean }>(`/tasks/${enc(id)}/cancel`),
		onSuccess: () => {
			// The task's own view and every list that shows it (and its group).
			void queryClient.invalidateQueries({ queryKey: taskKeys.all });
		},
	});
}

export interface CreateTaskGroupInput extends TaskRequest {
	targets: string[];
	parallel?: number;
	failFast?: boolean;
	/** Only an exec batch chooses; a file operation's group always keeps each node's head. */
	outputMode?: "status" | "text" | "head";
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

const GROUP_OPEN = new Set(["running", "awaiting_approval", "awaiting_authorization"]);

/** One task group: as `useTask`, with `GET /task-groups/:id/wait` for the open group. */
export function useTaskGroup(id: string | undefined, pollRunning = false) {
	return useQuery({
		queryKey: taskKeys.group(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal, client, queryKey }) => {
			const path = `/task-groups/${enc(id ?? "")}`;
			const known = client.getQueryData(queryKey) !== undefined;
			if (!pollRunning || !known) return http.get<{ group: TaskGroupView }>(path, { signal }).then((r) => r.group);
			return http
				.get<{ group: TaskGroupView }>(`${path}/wait${queryString({ timeoutMs: WAIT_TIMEOUT_MS })}`, { signal })
				.then((r) => r.group);
		},
		refetchInterval: (query) => {
			if (!pollRunning) return false;
			const state = query.state.data?.state;
			return state !== undefined && GROUP_OPEN.has(state) ? WAIT_GAP_MS : false;
		},
	});
}

/** The operation a task reports, used to build an "always allow" rule. */
export function taskOperation(task: TaskView | undefined): Operation | null {
	return task?.operation ?? null;
}
