import type { TaskView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { actionsHeader, type DataTableColumn } from "@/components/data-table";
import { RelativeTime } from "@/components/relative-time";
import { TaskStatusBadge } from "@/components/status-badge";
import { TaskOutcomeText } from "@/components/task-result";
import { Badge } from "@/components/ui/badge";
import { taskActor } from "./actor";

export interface TaskColumnOptions {
	/** Display names by user id, for the "By" column. */
	users: Map<string, string>;
	/** Node names by node id; when given, the table gets a node column. */
	nodeNames?: Map<string, string>;
	/** A node's own list: the summary carries the task's kind and every row links to the task. */
	perNode?: boolean;
}

/**
 * The task table columns shared by the tasks page and a node's recent tasks
 * (doc/webui.md "Tasks"): the same cells in the same order, plus the node
 * column on the global list and the details link on the per-node one.
 */
export function useTaskColumns({ users, nodeNames, perNode = false }: TaskColumnOptions): DataTableColumn<TaskView>[] {
	const { t } = useLingui();
	return useMemo(() => {
		const columns: DataTableColumn<TaskView>[] = [
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
						{perNode && row.original.summary !== "" && (
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
		];

		if (nodeNames) {
			const names = nodeNames;
			columns.push({
				id: "node",
				header: t`Node`,
				size: 140,
				cell: ({ row }) => (
					<span className="truncate text-xs leading-5">{names.get(row.original.nodeId) ?? row.original.nodeId}</span>
				),
			});
		}

		columns.push(
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
		);

		if (perNode) {
			columns.push({
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
			});
		}

		return columns;
	}, [nodeNames, perNode, t, users]);
}
