import type { CursorPage, JobView } from "@crh/api";
import { type InfiniteData, type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalKeys } from "@/features/approvals/api";
import { taskKeys } from "@/features/tasks/api";
import { enc, http, isNotFound, queryString } from "@/lib/api/client";
import { flattenCursorPages, useCursorInfiniteQuery } from "@/lib/api/query";

/** How often a job-backed row re-reads a job the job stream does not reach (a nested level, another page). */
export const JOB_POLL_MS = 5_000;

export const jobKeys = {
	all: ["jobs"] as const,
	detail: (id: string) => ["jobs", "detail", id] as const,
	session: (sessionId: string) => ["jobs", "session", sessionId] as const,
};

/**
 * One job (`GET /jobs/:id`). A tool row whose job has not settled follows it every few seconds, replacing the
 * per-kind task, group and session polling (doc/design/jobs.md "WebUI"); a settled job is read once more and
 * stops. A job retention removed answers 404 and also stops.
 */
export function useJob(id: string | undefined, enabled = true, pollMs = JOB_POLL_MS) {
	return useQuery({
		queryKey: jobKeys.detail(id ?? ""),
		enabled: enabled && id !== undefined && id !== "",
		queryFn: ({ signal }) => http.get<{ job: JobView }>(`/jobs/${enc(id ?? "")}`, { signal }).then((r) => r.job),
		refetchInterval: (query) => {
			const job = query.state.data;
			if (job === undefined || job.state === "settled" || isNotFound(query.state.error)) return false;
			return pollMs;
		},
	});
}

/**
 * One session's jobs (`GET /jobs?session=`), newest first, one cursor page at a time. The background bar asks
 * for active jobs only (waiting or running); a level still loads one page at a time, and the interval is the
 * fallback when a `job.changed` event was missed (the session stream carries the live changes).
 */
export function useSessionJobs(sessionId: string, active = true) {
	return useCursorInfiniteQuery<JobView>({
		queryKey: [...jobKeys.session(sessionId), active ? "active" : "all"],
		fetchPage: (cursor, signal) =>
			http.get<CursorPage<JobView>>(
				`/jobs${queryString({ session: sessionId, active: active ? "true" : undefined, cursor })}`,
				{ signal },
			),
		enabled: sessionId !== "",
		refetchInterval: JOB_POLL_MS,
	});
}

/** The jobs of a cursor query, flattened in display order; a malformed page contributes nothing. */
export function jobItems(data: InfiniteData<CursorPage<JobView>, string | null> | undefined): JobView[] {
	if (data === undefined || !Array.isArray(data.pages)) return [];
	return flattenCursorPages(data).filter(
		(job): job is JobView => typeof job === "object" && job !== null && typeof job.id === "string",
	);
}

/** Refreshes what a job cancel changes: the job itself, the approvals and the task pages. */
export function invalidateJobViews(queryClient: QueryClient): void {
	void queryClient.invalidateQueries({ queryKey: jobKeys.all });
	void queryClient.invalidateQueries({ queryKey: approvalKeys.all });
	void queryClient.invalidateQueries({ queryKey: taskKeys.all });
}

/** `POST /jobs/:id/cancel`: stop an extension call, the only job kind without a page and its own control. */
export function useCancelJob() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (jobId: string) => http.post<{ cancelled: boolean; job: JobView }>(`/jobs/${enc(jobId)}/cancel`, {}),
		onSuccess: () => invalidateJobViews(queryClient),
	});
}
