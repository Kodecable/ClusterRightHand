import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { DataTable } from "@/components/data-table";
import { TableEmpty } from "@/components/empty-state";
import { useNodeTasks } from "@/features/nodes/api";
import { useTaskColumns } from "@/features/tasks/task-columns";
import { useDirectory } from "@/features/users/api";

/** The node's recent tasks (doc/webui.md "TaskSummary"): newest first; a row opens its task. */
export function NodeTaskList({ nodeId }: { nodeId: string }) {
	const { t } = useLingui();
	const tasks = useNodeTasks(nodeId);
	const directory = useDirectory();
	const users = useMemo(
		() => new Map((directory.data?.users ?? []).map((user) => [user.id, user.displayName || user.username])),
		[directory.data],
	);
	const columns = useTaskColumns({ users, perNode: true });

	return (
		<section className="grid gap-2" aria-labelledby="node-tasks-heading" data-testid="node-tasks">
			<h2 id="node-tasks-heading" className="text-sm font-medium">
				<Trans>Recent tasks</Trans>
			</h2>
			<DataTable
				label={t`Node tasks`}
				columns={columns}
				data={tasks.data ?? []}
				getRowId={(task) => task.id}
				loading={tasks.isLoading}
				error={tasks.isError ? tasks.error : undefined}
				onRetry={() => void tasks.refetch()}
				rowLink={(task) => ({ to: "/tasks/$taskId", params: { taskId: task.id } })}
				rowLabel={(task) => task.summary || task.kind}
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
