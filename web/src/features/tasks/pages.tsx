import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { PlayIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { FieldShell } from "@/components/form";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { taskStateLabel } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNodes } from "@/features/nodes/api";
import { useDirectory } from "@/features/users/api";
import { taskTitle } from "@/lib/task-title";
import { useTasks } from "./api";
import { RunTaskDialog } from "./run-task-dialog";
import type { TasksSearch } from "./search";
import { useTaskColumns } from "./task-columns";

const STATES = [
	"awaiting_approval",
	"awaiting_authorization",
	"dispatched",
	"running",
	"exited",
	"failed",
	"rejected",
	"denied",
	"cancelled",
	"unknown",
];

function FilterSelect({
	id,
	label,
	value,
	onChange,
	options,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: { value: string; label: string }[];
}) {
	return (
		<FieldShell id={id} label={label} className="w-44">
			<Select value={value} onValueChange={(next) => onChange(String(next ?? "any"))}>
				<SelectTrigger id={id} size="sm" className="w-44">
					<SelectValue>
						{(current: string | null) => options.find((option) => option.value === current)?.label ?? ""}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</FieldShell>
	);
}

/**
 * The caller's tasks (doc/design/webui.md "Task and task group pages", doc/design/access-control.md): a cursor-paged
 * table with state / actor-type / node filters. Non-admins see only their own tasks;
 * administrators see every task. `?node=` and `?user=` open the page pre-filtered:
 * the node select reflects and writes the first, the second shows a removable
 * indicator because there is no other user filter control.
 */
export function TasksPage() {
	const { t, i18n } = useLingui();
	const nodes = useNodes();
	const directory = useDirectory();
	const search = useSearch({ strict: false }) as TasksSearch;
	const navigate = useNavigate();
	const [state, setState] = useState("any");
	const [actorType, setActorType] = useState("any");
	const [running, setRunning] = useState(false);
	const nodeId = search.node ?? "any";
	const userId = search.user;

	const tasks = useTasks({
		state: state === "any" ? undefined : state,
		actorType: actorType === "any" ? undefined : actorType,
		nodeId: nodeId === "any" ? undefined : nodeId,
		userId,
	});
	const rows = useMemo(() => tasks.data?.pages.flatMap((page) => page.items) ?? [], [tasks.data]);
	const users = useMemo(
		() => new Map((directory.data?.users ?? []).map((user) => [user.id, user.displayName || user.username])),
		[directory.data],
	);
	const names = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);
	const columns = useTaskColumns({ users, nodeNames: names });

	const setNode = (value: string) => {
		void navigate({
			to: "/tasks",
			search: (prev) => ({ ...prev, node: value === "any" ? undefined : value }),
			replace: true,
		});
	};
	const clearUser = () => {
		void navigate({
			to: "/tasks",
			search: (prev) => {
				const next = { ...(prev as TasksSearch) };
				delete next.user;
				return next;
			},
			replace: true,
		});
	};
	const nodeOptions = [
		{ value: "any", label: t`Any node` },
		...(nodes.data ?? []).map((node) => ({ value: node.id, label: node.name })),
	];
	// A node id from the URL stays visible in the select even before the node
	// list has loaded (or if the node is no longer visible).
	if (nodeId !== "any" && !names.has(nodeId)) nodeOptions.push({ value: nodeId, label: nodeId });
	const userName = userId === undefined ? "" : (users.get(userId) ?? userId);

	const actorTypes = [
		{ value: "any", label: t`Any actor` },
		{ value: "user", label: t`User` },
		{ value: "api_token", label: t`API token` },
		{ value: "agent", label: t`Agent` },
		{ value: "subagent", label: t`Subagent` },
		{ value: "schedule", label: t`Schedule` },
	];

	return (
		<Page data-testid="tasks-page">
			<PageHeader
				title={<Trans>Tasks</Trans>}
				actions={
					<Button type="button" onClick={() => setRunning(true)} data-testid="run-task">
						<PlayIcon />
						<Trans>Run task</Trans>
					</Button>
				}
			/>

			<div className="flex flex-wrap items-end gap-3">
				<FilterSelect
					id="task-filter-state"
					label={t`State`}
					value={state}
					onChange={setState}
					options={[
						{ value: "any", label: t`Any state` },
						...STATES.map((value) => ({ value, label: taskStateLabel(i18n, value) })),
					]}
				/>
				<FilterSelect
					id="task-filter-actor"
					label={t`Actor type`}
					value={actorType}
					onChange={setActorType}
					options={actorTypes}
				/>
				<FilterSelect id="task-filter-node" label={t`Node`} value={nodeId} onChange={setNode} options={nodeOptions} />
				{userId !== undefined && (
					<div className="flex items-center gap-1 pb-1" data-testid="user-filter">
						<span className="text-sm text-muted-foreground">{t`User: ${userName}`}</span>
						<Button type="button" variant="ghost" size="icon-xs" aria-label={t`Clear user filter`} onClick={clearUser}>
							<XIcon className="size-3.5" />
						</Button>
					</div>
				)}
			</div>

			<DataTable
				label={t`Tasks`}
				columns={columns}
				data={rows}
				getRowId={(task) => task.id}
				loading={tasks.isPending}
				error={tasks.error ?? undefined}
				onRetry={() => void tasks.refetch()}
				hasMore={tasks.hasNextPage ?? false}
				loadingMore={tasks.isFetchingNextPage}
				onLoadMore={() => void tasks.fetchNextPage()}
				rowLink={(task) => ({ to: "/tasks/$taskId", params: { taskId: task.id } })}
				rowLabel={(task) => taskTitle(task)}
				rowLinkColumn="task"
				empty={
					<EmptyState
						bare
						className="border-0 py-10"
						title={<Trans>No tasks yet</Trans>}
						description={<Trans>Run something on a node.</Trans>}
					/>
				}
			/>
			{running && <RunTaskDialog onClose={() => setRunning(false)} />}
		</Page>
	);
}
