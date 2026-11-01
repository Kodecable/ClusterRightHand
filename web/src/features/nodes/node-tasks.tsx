import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { useNodeTasks } from "@/features/nodes/api";
import { useTaskColumns } from "@/features/tasks/task-columns";
import { useDirectory } from "@/features/users/api";

/** The node's recent tasks (doc/webui.md "TaskSummary"): newest first, with a link to each task. */
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
