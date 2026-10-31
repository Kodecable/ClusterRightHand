import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CopyButton } from "@/components/copy-button";
import { type KeyValueItem, KeyValueList } from "@/components/key-value";
import { DateTime } from "@/components/relative-time";
import { TaskStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/features/auth/session";
import { batchOutput, joinOutput, statusOutputNoteKey, taskOutcome } from "@/features/tasks/output";
import type { TaskAuthorizationView, TaskView } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { DecisionView, EvaluationTable } from "./approval-card";

/** The authorization plan of a task that waits for a signature (doc/privilege.md#授权路径). */
function AuthorizationPlan({ record }: { record: TaskAuthorizationView }) {
	return (
		<div className="mt-1 grid gap-1 text-xs">
			{record.plan.paths.length > 0 && (
				<ul className="list-disc pl-4">
					{record.plan.paths.map((path) => (
						<li key={path.path}>
							<span className="font-medium">{path.path}</span>
							{path.entries.length > 0 && (
								<>
									{": "}
									{path.entries.map((entry) => `${entry.name} (${entry.role})`).join(", ")}
									{path.entries.some((entry) => entry.cosign) && (
										<>
											{" — "}
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
				<p className="text-muted-foreground">{record.plan.reason}</p>
			)}
			{record.lastRejection !== null && (
				<p className="text-danger">
					<Trans>
						Last rejection {record.lastRejection.code} (attempt {record.lastRejection.attempt}):{" "}
						{record.lastRejection.message}
					</Trans>
				</p>
			)}
		</div>
	);
}

export function OutputBlock({
	label,
	head,
	tail,
	bytes,
	className,
}: {
	label: string;
	head: string;
	tail: string;
	bytes: number;
	className?: string;
}) {
	if (bytes === 0 && head === "" && tail === "") return null;
	const { before, after, omitted } = joinOutput(head, tail, bytes);
	return (
		<section aria-label={label} className={cn("grid gap-1", className)}>
			<div className="flex items-center justify-between gap-2">
				<h4 className="text-xs font-medium text-muted-foreground">
					{label}{" "}
					<span className="font-normal">
						(<Plural value={bytes} one="# byte" other="# bytes" />)
					</span>
				</h4>
				<CopyButton text={before + after} label={`${label}: copy`} />
			</div>
			<pre className="max-h-72 overflow-auto rounded-md border bg-[var(--code)] p-2 font-mono text-xs whitespace-pre-wrap break-words">
				{before}
				{omitted > 0 && (
					<span className="text-warn">
						{"\n"}
						<Trans>… {omitted} bytes omitted …</Trans>
						{"\n"}
					</span>
				)}
				{after}
			</pre>
		</section>
	);
}

/** The outcome of a task as one translated line (exit code, signal, timeout, error). */
export function TaskOutcomeText({ task }: { task: TaskView }) {
	const outcome = taskOutcome(task);
	switch (outcome.kind) {
		case "exit":
			return <Trans>Exit code {outcome.code ?? "?"}</Trans>;
		case "signal":
			return <Trans>Signal {outcome.signal}</Trans>;
		case "timed-out":
			return <Trans>Timed out</Trans>;
		case "cancelled":
			return <Trans>Cancelled</Trans>;
		case "error":
			return (
				<span className="text-danger">
					{outcome.code ?? ""}
					{outcome.code !== null && outcome.message !== null ? ": " : ""}
					{outcome.message ?? ""}
				</span>
			);
		default:
			return <span className="text-muted-foreground">{outcome.state}</span>;
	}
}

/**
 * The full task result used by the task page, the approval pages, batch runs,
 * the run panel and the session's tool cards (doc/webui.md "TaskResult").
 */
export function TaskResult({ task, className }: { task: TaskView; className?: string }) {
	const { t } = useLingui();
	const auth = useAuth();
	const user = auth.user;
	const output = batchOutput(task);
	const approvalLink = (
		<Link
			to="/approvals/tasks/$taskId"
			params={{ taskId: task.id }}
			className="text-primary underline underline-offset-2"
		>
			<Trans>Open approval page</Trans>
		</Link>
	);

	const items: KeyValueItem[] = [
		{
			label: <Trans>Task</Trans>,
			value: (
				<span className="flex items-center gap-1">
					<span className="font-mono text-xs">{task.id}</span>
					<CopyButton text={task.id} label={t`Copy task id`} />
				</span>
			),
		},
		{
			label: <Trans>Kind</Trans>,
			value: (
				<span className="flex items-center gap-1.5">
					<span className="font-mono text-xs">{task.kind}</span>
					{task.privileged && (
						<Badge variant="secondary">
							<Trans>Privileged</Trans>
						</Badge>
					)}
				</span>
			),
		},
		...(task.summary !== ""
			? [{ label: <Trans>Summary</Trans>, value: <span className="font-mono text-xs">{task.summary}</span> }]
			: []),
		{
			label: <Trans>State</Trans>,
			value: <TaskStatusBadge state={task.state} exitCode={task.exitCode} signal={task.signal} />,
		},
		...(task.exitCode !== null ? [{ label: <Trans>Exit code</Trans>, value: String(task.exitCode) }] : []),
		...(task.signal !== null ? [{ label: <Trans>Signal</Trans>, value: task.signal }] : []),
		...(task.errorCode !== null || task.errorMessage !== null
			? [
					{
						label: <Trans>Error</Trans>,
						value: (
							<span className="text-danger">
								{task.errorCode ?? ""} {task.errorMessage ?? ""}
							</span>
						),
					},
				]
			: []),
		...(task.state === "awaiting_approval"
			? [{ label: <Trans>Approval</Trans>, value: <Trans>Waiting for approval. {approvalLink}</Trans> }]
			: []),
		...(task.state === "awaiting_authorization"
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
		...(task.approval?.decision
			? [{ label: <Trans>Approval decision</Trans>, value: <DecisionView decision={task.approval.decision} /> }]
			: []),
		{ label: <Trans>Created</Trans>, value: <DateTime value={task.createdAt} /> },
		{ label: <Trans>Finished</Trans>, value: <DateTime value={task.finishedAt} /> },
		...(task.outputFile !== null
			? [{ label: <Trans>Output file</Trans>, value: <span className="font-mono text-xs">{task.outputFile}</span> }]
			: []),
	];

	const note = statusOutputNoteKey(task);

	return (
		<div data-slot="task-result" className={cn("grid gap-3", className)}>
			<KeyValueList items={items} className="text-sm" />

			{task.approval && task.state !== "exited" && (
				<details className="rounded-md border p-2">
					<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
						<Trans>Rule chain evaluation</Trans>
					</summary>
					<div className="mt-2">
						<EvaluationTable evaluation={task.approval.evaluation} />
					</div>
				</details>
			)}

			{output.kind === "tail" ? (
				<OutputBlock label={t`output`} head="" tail={output.text} bytes={output.bytes} />
			) : output.kind === "status" ? (
				<p className="text-sm text-muted-foreground">
					<Trans>Status only.</Trans>{" "}
					{output.file !== null ? (
						<Trans>
							The full output is in <span className="font-mono text-xs">{output.file}</span> on the node.
						</Trans>
					) : note === "running" ? (
						<Trans>The full output stays on the node until the task exits.</Trans>
					) : note === "none" ? (
						<Trans>No output was kept.</Trans>
					) : (
						<Trans>No output is kept (SSH nodes keep no output).</Trans>
					)}
				</p>
			) : (
				<>
					<OutputBlock label={t`stdout`} head={task.stdoutHead} tail={task.stdoutTail} bytes={task.stdoutBytes} />
					<OutputBlock label={t`stderr`} head={task.stderrHead} tail={task.stderrTail} bytes={task.stderrBytes} />
				</>
			)}
		</div>
	);
}

/**
 * One compact row for a task inside a list: status, summary, node and when it
 * was created. It links to the task page.
 */
export function TaskSummary({ task, nodeName, className }: { task: TaskView; nodeName?: string; className?: string }) {
	return (
		<Link
			to="/tasks/$taskId"
			params={{ taskId: task.id }}
			data-slot="task-summary"
			data-testid="task-summary"
			className={cn("flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent", className)}
		>
			<TaskStatusBadge state={task.state} exitCode={task.exitCode} signal={task.signal} />
			<span className="min-w-0 flex-1 truncate font-mono text-xs">{task.summary || task.kind}</span>
			{nodeName !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{nodeName}</span>}
			<span className="shrink-0 text-xs text-muted-foreground">
				<TaskOutcomeText task={task} />
			</span>
			<DateTime value={task.createdAt} className="shrink-0 text-xs text-muted-foreground" />
		</Link>
	);
}
