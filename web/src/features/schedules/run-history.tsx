import type { ScheduleRunView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { DateTime } from "@/components/relative-time";
import { ScheduleStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useScheduleRuns } from "./api";
import { runNoteParts, runStatusText } from "./scheduleForm";

/** A schedule's last 20 runs, polling while an instance is in progress. */
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
				cell: ({ row }) => <DateTime value={row.original.fireTime} seconds />,
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
					<DateTime value={row.original.finishedAt ?? row.original.startedAt ?? row.original.createdAt} seconds />
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
						<Link
							to="/sessions/$sessionId"
							params={{ sessionId: row.original.sessionId }}
							className="font-mono text-xs text-primary underline underline-offset-2"
						>
							{row.original.sessionId.slice(0, 8)}
						</Link>
					),
			},
			{
				id: "note",
				header: t`Note`,
				cell: ({ row }) => {
					const { status, reason, manual } = runNoteParts(row.original);
					return (
						<span className="text-xs">
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
			<div className="flex items-center justify-between gap-2">
				<h2 id="schedule-runs-heading" className="text-sm font-semibold">
					<Trans>Run history</Trans>
				</h2>
				<Button type="button" variant="outline" size="sm" onClick={() => void runs.refetch()}>
					<Trans>Refresh</Trans>
				</Button>
			</div>
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
