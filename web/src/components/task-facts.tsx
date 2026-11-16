import type { TaskAuthorizationView, TaskGroupView, TaskView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { CopyableId } from "@/components/copyable-id";
import { DecisionView } from "@/components/decision/evaluation";
import { type KeyValueItem, KeyValueList } from "@/components/key-value";
import { PrivilegedMark } from "@/components/privileged-mark";
import { DateTime } from "@/components/relative-time";
import { TaskStatusBadge } from "@/components/status-badge";
import { TaskOutcomeBadge } from "@/components/task-outcome";
import { useAuth } from "@/lib/session";
import { taskErrorText } from "@/lib/task-output";
import { cn, MONO_CELL } from "@/lib/utils";
import { InternalLink } from "./internal-link";

/** The authorization plan of a task that waits for a signature (doc/design/privilege.md "Authorization path"). */
function AuthorizationPlan({ record }: { record: TaskAuthorizationView }) {
	return (
		<div className="mt-1 grid gap-1 text-xs">
			{record.plan.paths.length > 0 && (
				<ul className="list-disc pl-4">
					{record.plan.paths.map((path) => (
						<li key={path.path} className="break-words [overflow-wrap:anywhere]">
							<span className="font-medium">{path.path}</span>
							{path.entries.length > 0 && (
								<>
									{": "}
									{path.entries.map((entry) => `${entry.name} (${entry.role})`).join(", ")}
									{path.entries.some((entry) => entry.cosign) && (
										<>
											{" · "}
											{path.entries.some((entry) => entry.cosign === "missing") ? (
												<Trans>cosignature unavailable</Trans>
											) : (
												<Trans>cosignature available</Trans>
											)}
										</>
									)}
								</>
							)}
						</li>
					))}
				</ul>
			)}
			{record.plan.reason !== undefined && record.plan.reason !== "" && (
				<p className="text-muted-foreground break-words [overflow-wrap:anywhere]">{record.plan.reason}</p>
			)}
			{record.lastRejection !== null && (
				<p className="text-danger break-words [overflow-wrap:anywhere]">
					<Trans>
						Last rejection {record.lastRejection.code} (attempt {record.lastRejection.attempt}):{" "}
						{record.lastRejection.message}
					</Trans>
				</p>
			)}
		</div>
	);
}

/*
 * The shared fact rows: the id with its copy button, the kind with the privileged mark, an optional
 * purpose and the timestamps. A task's and a task group's facts are built from the same rows, so the two
 * pages read alike (doc/design/webui.md "Task and task group pages").
 */

function idFact(label: React.ReactNode, id: string, copyLabel: string): KeyValueItem {
	return {
		label,
		value: <CopyableId id={id} copyLabel={copyLabel} />,
		control: true,
	};
}

function kindFact(kind: string, privileged: boolean): KeyValueItem {
	return {
		label: <Trans>Kind</Trans>,
		value: (
			<span className="flex items-center gap-1.5">
				<span className={MONO_CELL}>{kind}</span>
				{privileged && <PrivilegedMark />}
			</span>
		),
		control: true,
	};
}

function purposeFact(purpose: string | null | undefined): KeyValueItem | undefined {
	if (purpose === null || purpose === undefined || purpose === "") return undefined;
	return { label: <Trans>Purpose</Trans>, value: purpose === "browse" ? <Trans>File browsing</Trans> : purpose };
}

function timestampFacts(createdAt: string, finishedAt: string | null): KeyValueItem[] {
	return [
		{ label: <Trans>Created</Trans>, value: <DateTime value={createdAt} /> },
		{ label: <Trans>Finished at</Trans>, value: <DateTime value={finishedAt} /> },
	];
}

/**
 * The facts of one task: the id, what it is, where it came from, where it ran, its state and result
 * fields, and its timestamps. The task page adds the node link (it knows the node name) and turns off
 * what its header, waiting card or decision block already show, so no fact appears twice on that page.
 */
export function TaskFacts({
	task,
	node,
	source,
	userNames,
	extra = [],
	showSummary = true,
	showState = true,
	showOutcome = true,
	showWaiting = true,
	showDecision = true,
	className,
}: {
	task: TaskView;
	/** The node link, when the caller knows the node's name. */
	node?: React.ReactNode;
	/** The request source, on pages that show its facts (the page variant renders it from `task.source`). */
	source?: React.ReactNode;
	/** Display names by user id, for a recorded approval decision. */
	userNames?: Map<string, string>;
	/** Further page-specific facts, e.g. the links to a session or a task group. */
	extra?: readonly KeyValueItem[];
	showSummary?: boolean;
	showState?: boolean;
	showOutcome?: boolean;
	showWaiting?: boolean;
	showDecision?: boolean;
	className?: string;
}) {
	const { t, i18n } = useLingui();
	const auth = useAuth();
	const user = auth.user;
	const approvalLink = (
		<InternalLink to="/approvals/tasks/$taskId" params={{ taskId: task.id }}>
			<Trans>Open approval page</Trans>
		</InternalLink>
	);
	const purpose = purposeFact(task.purpose);

	const items: KeyValueItem[] = [
		idFact(<Trans>Task</Trans>, task.id, t`Copy task id`),
		kindFact(task.kind, task.privileged),
		...(showSummary && task.summary !== "" ? [{ label: <Trans>Summary</Trans>, value: task.summary, mono: true }] : []),
		...(purpose !== undefined ? [purpose] : []),
		...(node !== undefined ? [{ label: <Trans>Node</Trans>, value: node }] : []),
		...(source !== undefined ? [{ label: <Trans>Source</Trans>, value: source }] : []),
		...(showState
			? [
					{
						label: <Trans>Status</Trans>,
						value: <TaskStatusBadge state={task.state} />,
					},
				]
			: []),
		...(showOutcome && task.outcome !== null
			? [{ label: <Trans>Outcome</Trans>, value: <TaskOutcomeBadge outcome={task.outcome} /> }]
			: []),
		...(task.exitCode !== null ? [{ label: <Trans>Exit code</Trans>, value: String(task.exitCode) }] : []),
		...(task.signal !== null ? [{ label: <Trans>Signal</Trans>, value: task.signal }] : []),
		...(task.errorCode !== null || task.errorMessage !== null
			? [
					{
						label: <Trans>Error</Trans>,
						value: <span className="text-danger">{taskErrorText(i18n, task.errorCode, task.errorMessage)}</span>,
					},
				]
			: []),
		...(showWaiting && task.state === "awaiting_approval"
			? [{ label: <Trans>Approval</Trans>, value: <Trans>Waiting for approval. {approvalLink}</Trans> }]
			: []),
		...(showWaiting && task.state === "awaiting_authorization"
			? [
					{
						label: <Trans>Authorization</Trans>,
						value: (
							<div className="grid gap-1">
								<span>
									{task.onBehalfOfUserId !== null && task.onBehalfOfUserId === user?.id ? (
										<Trans>Waiting for your signature.</Trans>
									) : (
										<Trans>Waiting for the owner's authorization.</Trans>
									)}
									{task.authorization ? <> (attempt {task.authorization.attempt})</> : null}
								</span>
								{task.authorization ? <AuthorizationPlan record={task.authorization} /> : null}
							</div>
						),
					},
				]
			: []),
		...(showDecision && task.approval?.decision
			? [
					{
						label: <Trans>Approval decision</Trans>,
						value: <DecisionView decision={task.approval.decision} userNames={userNames} />,
					},
				]
			: []),
		...extra,
		...timestampFacts(task.createdAt, task.finishedAt),
		...(task.outputFile !== null ? [{ label: <Trans>Output file</Trans>, value: task.outputFile, mono: true }] : []),
	];

	return <KeyValueList items={items} className={cn("text-sm", className)} />;
}

/**
 * The facts of one task group, built from the same rows as {@link TaskFacts}: the id, what it is, where
 * it came from, the stored targets, its outcome and its timestamps. The group page shows this block once,
 * above the member table; the status above the title is the same value the task page shows there.
 */
export function TaskGroupFacts({
	taskGroup,
	nodes,
	source,
	className,
}: {
	taskGroup: TaskGroupView;
	/** The stored targets as links, when the page knows the node names. */
	nodes?: React.ReactNode;
	/** The request source, when the page shows its facts. */
	source?: React.ReactNode;
	className?: string;
}) {
	const { t } = useLingui();
	const purpose = purposeFact(taskGroup.purpose);
	const items: KeyValueItem[] = [
		idFact(<Trans>Task group</Trans>, taskGroup.id, t`Copy task group id`),
		kindFact(taskGroup.kind, taskGroup.privileged),
		...(purpose !== undefined ? [purpose] : []),
		...(nodes !== undefined ? [{ label: <Trans>Nodes</Trans>, value: nodes }] : []),
		...(source !== undefined ? [{ label: <Trans>Source</Trans>, value: source }] : []),
		...(taskGroup.outcome !== null
			? [{ label: <Trans>Outcome</Trans>, value: <TaskOutcomeBadge outcome={taskGroup.outcome} /> }]
			: []),
		...timestampFacts(taskGroup.createdAt, taskGroup.finishedAt),
	];
	return <KeyValueList items={items} className={cn("text-sm", className)} />;
}
