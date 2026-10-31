import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { TaskStatusBadge } from "@/components/status-badge";
import { TaskOutcomeText } from "@/components/task-result";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useNodeTasks } from "@/features/nodes/api";
import { taskActor } from "@/features/tasks/actor";
import { useDirectory } from "@/features/users/api";
import type { TaskView } from "@/lib/api/types";

/** The node's recent tasks (doc/webui.md "TaskSummary"): newest first, with a link to each task. */
export function NodeTaskList({ nodeId }: { nodeId: string }) {
	const { t } = useLingui();
	const tasks = useNodeTasks(nodeId);
	const directory = useDirectory();
	const users = useMemo(
		() => new Map((directory.data?.users ?? []).map((user) => [user.id, user.displayName || user.username])),
		[directory.data],
	);

	const columns = useMemo<DataTableColumn<TaskView>[]>(
		() => [
			{
				id: "created",
				header: t`Created`,
				size: 110,
				cell: ({ row }) => <RelativeTime value={row.original.createdAt} className="text-xs" />,
			},
			{
				id: "task",
				header: t`Task`,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-1.5">
						<span className="truncate font-mono text-xs leading-5">{row.original.summary || row.original.kind}</span>
						{row.original.summary !== "" && (
							<span className="text-xs text-muted-foreground">({row.original.kind})</span>
						)}
						{row.original.privileged && (
							<Badge variant="secondary">
								<Trans>Privileged</Trans>
							</Badge>
						)}
					</span>
				),
			},
			{
				id: "actor",
				header: t`By`,
				size: 130,
				cell: ({ row }) => {
					const actor = taskActor(row.original, (id) => users.get(id));
					return (
						<span className="block truncate text-xs leading-5" title={actor.id}>
							{actor.name}
						</span>
					);
				},
			},
			{
				id: "state",
				header: t`State`,
				size: 160,
				cell: ({ row }) => (
					<TaskStatusBadge state={row.original.state} exitCode={row.original.exitCode} signal={row.original.signal} />
				),
			},
			{
				id: "outcome",
				header: t`Outcome`,
				size: 130,
				cell: ({ row }) => (
					<span className="truncate text-xs leading-5">
						<TaskOutcomeText task={row.original} />
					</span>
				),
			},
			{
				id: "details",
				header: actionsHeader,
				size: 80,
				cell: ({ row }) => (
					<Link
						to="/tasks/$taskId"
						params={{ taskId: row.original.id }}
						aria-label={t`Open task`}
						className="text-xs text-primary underline underline-offset-2"
					>
						<Trans>Details</Trans>
					</Link>
				),
			},
		],
		[t, users],
	);

	return (
		<section className="grid gap-2" aria-labelledby="node-tasks-heading" data-testid="node-tasks">
			<div className="flex items-center justify-between gap-2">
				<h2 id="node-tasks-heading" className="text-sm font-semibold">
					<Trans>Recent tasks</Trans>
				</h2>
				<Button type="button" variant="outline" size="sm" onClick={() => void tasks.refetch()}>
					<Trans>Refresh</Trans>
				</Button>
			</div>
			<DataTable
				label={t`Node tasks`}
				columns={columns}
				data={tasks.data ?? []}
				getRowId={(task) => task.id}
				loading={tasks.isLoading}
				error={tasks.isError ? tasks.error : undefined}
				onRetry={() => void tasks.refetch()}
				empty={
					<EmptyState title={<Trans>No tasks yet</Trans>} description={<Trans>Run a task to see it here.</Trans>} />
				}
			/>
		</section>
	);
}
