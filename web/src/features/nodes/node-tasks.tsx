import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { DataTable } from "@/components/data-table";
import { TableEmpty } from "@/components/empty-state";
import { SectionHeader } from "@/components/section";
import { useNodeTasks } from "@/features/nodes/api";
import { useTaskColumns } from "@/features/tasks/task-columns";
import { taskTitle } from "@/features/tasks/title";
import { useDirectory } from "@/features/users/api";
import { linkClass } from "@/lib/utils";

/** The node's recent tasks (doc/design/webui.md "Task and task group pages"): newest first; a row opens its task. */
export function NodeTaskList({ nodeId }: { nodeId: string }) {
	const { t } = useLingui();
	const tasks = useNodeTasks(nodeId);
	const directory = useDirectory();
	const users = useMemo(
		() => new Map((directory.data?.users ?? []).map((user) => [user.id, user.displayName || user.username])),
		[directory.data],
	);
	const columns = useTaskColumns({ users });

	return (
		<section className="grid gap-2" aria-labelledby="node-tasks-heading" data-testid="node-tasks">
			<SectionHeader
				id="node-tasks-heading"
				title={<Trans>Recent tasks</Trans>}
				actions={
					<Link to="/tasks" search={{ node: nodeId }} className={linkClass}>
						<Trans>View all tasks</Trans>
					</Link>
				}
			/>
			<DataTable
				label={t`Node tasks`}
				columns={columns}
				data={tasks.data ?? []}
				getRowId={(task) => task.id}
				loading={tasks.isLoading}
				error={tasks.isError ? tasks.error : undefined}
				onRetry={() => void tasks.refetch()}
				rowLink={(task) => ({ to: "/tasks/$taskId", params: { taskId: task.id } })}
				rowLabel={(task) => taskTitle(task)}
				rowLinkColumn="task"
				empty={
					<TableEmpty>
						<Trans>No tasks yet</Trans>
					</TableEmpty>
				}
			/>
		</section>
	);
}
