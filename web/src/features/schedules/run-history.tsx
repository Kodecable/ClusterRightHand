import type { ScheduleRunView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { ScheduleStatusBadge } from "@/components/status-badge";
import { useScheduleRuns } from "./api";
import { runNoteParts, runStatusText } from "./scheduleForm";

/** A schedule's last 20 runs, polling while an instance is in progress; a run with a session links to it. */
export function RunHistory({ scheduleId, inProgress }: { scheduleId: string; inProgress: boolean }) {
	const { t, i18n } = useLingui();
	const runs = useScheduleRuns(scheduleId, 20, inProgress ? 2_000 : false);
	const rows = useMemo(() => runs.data?.pages.flatMap((page) => page.items) ?? [], [runs.data]);

	const columns = useMemo<DataTableColumn<ScheduleRunView>[]>(
		() => [
			{
				id: "fireTime",
				header: t`Triggered for`,
				size: 170,
				cell: ({ row }) => <RelativeTime value={row.original.fireTime} />,
			},
			{
				id: "status",
				header: t`Status`,
				size: 120,
				cell: ({ row }) => <ScheduleStatusBadge status={row.original.status} />,
			},
			{
				id: "when",
				header: t`When`,
				size: 170,
				cell: ({ row }) => (
					<RelativeTime value={row.original.finishedAt ?? row.original.startedAt ?? row.original.createdAt} />
				),
			},
			{
				id: "session",
				header: t`Session`,
				size: 110,
				cell: ({ row }) =>
					row.original.sessionId === null ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<code className="font-mono text-xs">{row.original.sessionId.slice(0, 8)}</code>
					),
			},
			{
				id: "note",
				header: t`Note`,
				cell: ({ row }) => {
					const { status, reason, manual } = runNoteParts(row.original);
					return (
						<span>
							{reason ?? runStatusText(i18n, status)}
							{manual && (
								<span className="text-muted-foreground">
									{" · "}
									<Trans>run by hand</Trans>
								</span>
							)}
						</span>
					);
				},
			},
		],
		[i18n, t],
	);

	return (
		<section className="grid gap-2" aria-labelledby="schedule-runs-heading" data-testid="schedule-runs">
			<h2 id="schedule-runs-heading" className="text-sm font-semibold">
				<Trans>Run history</Trans>
			</h2>
			<DataTable
				label={t`Schedule runs`}
				columns={columns}
				data={rows}
				getRowId={(run) => run.id}
				loading={runs.isLoading}
				error={runs.isError ? runs.error : undefined}
				onRetry={() => void runs.refetch()}
				hasMore={runs.hasNextPage}
				loadingMore={runs.isFetchingNextPage}
				onLoadMore={() => void runs.fetchNextPage()}
				rowLink={(run) =>
					run.sessionId === null ? undefined : { to: "/sessions/$sessionId", params: { sessionId: run.sessionId } }
				}
				rowLabel={(run) => t`Open session ${(run.sessionId ?? "").slice(0, 8)}`}
				empty={
					<EmptyState
						title={<Trans>No runs yet</Trans>}
						description={<Trans>This schedule has not fired yet.</Trans>}
					/>
				}
			/>
		</section>
	);
}
