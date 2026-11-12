import type { TaskView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import type { DataTableColumn } from "@/components/data-table";
import { RelativeTime } from "@/components/relative-time";
import { TaskStatusBadge } from "@/components/status-badge";
import { TaskOutcomeText } from "@/components/task-result";
import { Badge } from "@/components/ui/badge";
import { UserLink } from "@/components/user-link";
import { taskTitle } from "@/lib/task-title";
import { cn, MONO_CELL } from "@/lib/utils";
import { taskActor } from "./actor";

export interface TaskColumnOptions {
	/** Display names by user id, for the "By" column. */
	users: Map<string, string>;
	/** Node names by node id; when given, the table gets a node column. */
	nodeNames?: Map<string, string>;
}

/**
 * The task table columns shared by the tasks page and a node's recent tasks
 * (doc/design/webui.md "Task and task group pages"): the same cells in the same order, plus the node
 * column on the global list. The row itself links to the task on both.
 */
export function useTaskColumns({ users, nodeNames }: TaskColumnOptions): DataTableColumn<TaskView>[] {
	const { t } = useLingui();
	return useMemo(() => {
		const columns: DataTableColumn<TaskView>[] = [
			{
				id: "created",
				header: t`Created`,
				size: 110,
				cell: ({ row }) => <RelativeTime value={row.original.createdAt} />,
			},
			{
				id: "task",
				header: t`Task`,
				minSize: 160,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-1.5">
						<span className={cn("truncate", MONO_CELL)}>{taskTitle(row.original)}</span>
						{row.original.privileged && (
							<Badge variant="secondary">
								<Trans>Privileged</Trans>
							</Badge>
						)}
					</span>
				),
				meta: { title: (task: TaskView) => taskTitle(task) },
			},
		];

		if (nodeNames) {
			const names = nodeNames;
			columns.push({
				id: "node",
				header: t`Node`,
				minSize: 140,
				cell: ({ row }) => (
					<span className="truncate leading-5">{names.get(row.original.nodeId) ?? row.original.nodeId}</span>
				),
				meta: { title: (task: TaskView) => names.get(task.nodeId) ?? task.nodeId },
			});
		}

		columns.push(
			{
				id: "actor",
				header: t`By`,
				size: 120,
				cell: ({ row }) => {
					const actor = taskActor(row.original, (id) => users.get(id));
					return (
						<span className="block truncate leading-5" title={actor.id}>
							<UserLink id={actor.id} name={actor.name} />
						</span>
					);
				},
			},
			{
				id: "state",
				header: t`Status`,
				size: 90,
				cell: ({ row }) => <TaskStatusBadge state={row.original.state} />,
			},
			{
				id: "outcome",
				header: t`Outcome`,
				size: 120,
				cell: ({ row }) => (
					<span className="truncate leading-5">
						<TaskOutcomeText task={row.original} />
					</span>
				),
			},
		);

		return columns;
	}, [nodeNames, t, users]);
}
