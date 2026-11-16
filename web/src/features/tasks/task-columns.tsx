import type { TaskView } from "@crh/api";
import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import type { DataTableColumn } from "@/components/data-table";
import { PrivilegedMark } from "@/components/privileged-mark";
import { RelativeTime } from "@/components/relative-time";
import { RequestSource } from "@/components/request-source";
import { TaskStatusBadge } from "@/components/status-badge";
import { TaskOutcomeBadge } from "@/components/task-outcome";
import { taskTitle } from "@/lib/task-title";
import { cn, MONO_CELL } from "@/lib/utils";

export interface TaskColumnOptions {
	/** Node names by node id; when given, the table gets a node column. */
	nodeNames?: Map<string, string>;
}

/**
 * The task table columns shared by the tasks page, a node's recent tasks and a user's recent tasks
 * (doc/design/webui.md "Task and task group pages"): the same cells in the same order, plus the node
 * column on the global list. The row itself links to the task on every list.
 */
export function useTaskColumns({ nodeNames }: TaskColumnOptions): DataTableColumn<TaskView>[] {
	const { t, i18n } = useLingui();
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
						<span className={cn("truncate", MONO_CELL)}>{taskTitle(i18n, row.original)}</span>
						{row.original.privileged && <PrivilegedMark />}
					</span>
				),
				meta: { title: (task: TaskView) => taskTitle(i18n, task) },
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
				id: "source",
				header: t`Source`,
				minSize: 160,
				cell: ({ row }) => <RequestSource source={row.original.source} className="block truncate leading-5" />,
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
				size: 150,
				cell: ({ row }) => (
					<span className="block truncate leading-5">
						<TaskOutcomeBadge outcome={row.original.outcome} />
					</span>
				),
			},
		);

		return columns;
	}, [i18n, nodeNames, t]);
}
