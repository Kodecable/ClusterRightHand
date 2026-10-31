import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http, queryString } from "@/lib/api/client";
import { useCursorInfiniteQuery } from "@/lib/api/query";
import type { CursorPage, ScheduleInput, ScheduleRunView, ScheduleView } from "@/lib/api/types";

export const scheduleKeys = {
	all: ["schedules"] as const,
	list: () => ["schedules", "list"] as const,
	detail: (id: string) => ["schedules", "detail", id] as const,
	runs: (id: string) => ["schedules", "runs", id] as const,
};

export function useSchedules() {
	return useQuery({
		queryKey: scheduleKeys.list(),
		queryFn: ({ signal }) => http.get<{ schedules: ScheduleView[] }>("/schedules", { signal }).then((r) => r.schedules),
	});
}

export function useSchedule(id: string | undefined) {
	return useQuery({
		queryKey: scheduleKeys.detail(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ schedule: ScheduleView }>(`/schedules/${enc(id ?? "")}`, { signal }).then((r) => r.schedule),
	});
}

/** `GET /api/schedules/:id/runs` is cursor-paged (doc/webui.md "游标列表"). */
export function useScheduleRuns(id: string | undefined, limit?: number) {
	return useCursorInfiniteQuery<ScheduleRunView>({
		queryKey: scheduleKeys.runs(id ?? ""),
		fetchPage: (cursor, signal) =>
			http.get<CursorPage<ScheduleRunView>>(`/schedules/${enc(id ?? "")}/runs${queryString({ cursor, limit })}`, {
				signal,
			}),
		enabled: id !== undefined && id !== "",
	});
}

export function useCreateSchedule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: ScheduleInput) =>
			http.post<{ schedule: ScheduleView }>("/schedules", input).then((r) => r.schedule),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
	});
}

export function usePatchSchedule(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: Partial<ScheduleInput>) =>
			http.patch<{ schedule: ScheduleView }>(`/schedules/${enc(id)}`, patch).then((r) => r.schedule),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
	});
}

export function useDeleteSchedule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/schedules/${enc(id)}`, {}),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
	});
}

export function useRunSchedule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.post<{ run: ScheduleRunView }>(`/schedules/${enc(id)}/run`, {}).then((r) => r.run),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: scheduleKeys.all }),
	});
}

/** The next fire times for a cron/timezone, without saving anything. */
export function usePreviewSchedule() {
	return useMutation({
		mutationFn: ({ cron, timezone, count }: { cron: string; timezone: string; count?: number }) =>
			http.post<{ times: string[] }>("/schedules/preview", { cron, timezone, count: count ?? 5 }).then((r) => r.times),
	});
}
