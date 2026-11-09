import type { TaskAuthorizationView, TaskResultView, TaskView } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CopyButton } from "@/components/copy-button";
import { type KeyValueItem, KeyValueList } from "@/components/key-value";
import { DateTime, RelativeTime } from "@/components/relative-time";
import { TaskStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/features/auth/session";
import { batchOutput, joinOutput, statusOutputNoteKey, taskErrorText, taskOutcome } from "@/features/tasks/output";
import { cn, linkClass } from "@/lib/utils";
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
	const { i18n } = useLingui();
	const outcome = taskOutcome(task);
	switch (outcome.kind) {
		case "succeeded":
			return <Trans>Succeeded</Trans>;
		case "exit":
			return <Trans>Exit code {outcome.code ?? "?"}</Trans>;
		case "signal":
			return <Trans>Signal {outcome.signal}</Trans>;
		case "timed-out":
			return <Trans>Timed out</Trans>;
		case "cancelled":
			return <Trans>Cancelled</Trans>;
		case "error":
			return <span className="text-danger">{taskErrorText(i18n, outcome.code, outcome.message)}</span>;
		default:
			// No exit code, signal or error: the status next to it says the rest,
			// so the outcome column stays empty instead of echoing a raw state.
			return <span className="text-muted-foreground">–</span>;
	}
}

/**
 * The facts of one task: the id, what it is, who asked, where it ran, its
 * state and result fields, and its timestamps. The task page adds the node
 * link (it knows the node name) and turns off what its header, waiting card or
 * decision block already show, so no fact appears twice on that page.
 */
export function TaskFacts({
	task,
	node,
	askedBy,
	extra = [],
	showSummary = true,
	showState = true,
	showWaiting = true,
	showDecision = true,
	className,
}: {
	task: TaskView;
	/** The node link, when the caller knows the node's name. */
	node?: React.ReactNode;
	/** Who asked for the task, when the caller resolved its display name. */
	askedBy?: React.ReactNode;
	/** Further page-specific facts, e.g. the links to a session or a task group. */
	extra?: readonly KeyValueItem[];
	showSummary?: boolean;
	showState?: boolean;
	showWaiting?: boolean;
	showDecision?: boolean;
	className?: string;
}) {
	const { t, i18n } = useLingui();
	const auth = useAuth();
	const user = auth.user;
	const approvalLink = (
		<Link to="/approvals/tasks/$taskId" params={{ taskId: task.id }} className={linkClass}>
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
		...(showSummary && task.summary !== ""
			? [{ label: <Trans>Summary</Trans>, value: <span className="font-mono text-xs">{task.summary}</span> }]
			: []),
		...(node !== undefined ? [{ label: <Trans>Node</Trans>, value: node }] : []),
		...(askedBy !== undefined ? [{ label: <Trans>Asked by</Trans>, value: askedBy }] : []),
		...(showState
			? [
					{
						label: <Trans>Status</Trans>,
						value: <TaskStatusBadge state={task.state} />,
					},
				]
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
			? [{ label: <Trans>Approval decision</Trans>, value: <DecisionView decision={task.approval.decision} /> }]
			: []),
		...extra,
		{ label: <Trans>Created</Trans>, value: <DateTime value={task.createdAt} /> },
		{ label: <Trans>Finished at</Trans>, value: <DateTime value={task.finishedAt} /> },
		...(task.outputFile !== null
			? [{ label: <Trans>Output file</Trans>, value: <span className="font-mono text-xs">{task.outputFile}</span> }]
			: []),
	];

	return <KeyValueList items={items} className={cn("text-sm", className)} />;
}

/** The rule chain that produced an approval decision, folded away. */
export function TaskEvaluation({
	task,
	tokenNames,
	className,
}: {
	task: TaskView;
	tokenNames?: Map<string, string>;
	className?: string;
}) {
	if (!task.approval || task.state === "exited") return null;
	return (
		<details className={cn("rounded-md border p-2", className)}>
			<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
				<Trans>Rule chain evaluation</Trans>
			</summary>
			<div className="mt-2">
				<EvaluationTable evaluation={task.approval.evaluation} tokenNames={tokenNames} />
			</div>
		</details>
	);
}

/** A page's line range and whether the scan reached the end of the file (doc/protocol.md TaskResult). */
function ReadResultView({ result }: { result: Extract<TaskResultView, { kind: "file.read" }> }) {
	const { from, to, eof, total, tooLong } = result;
	return (
		<p className="text-sm text-muted-foreground" data-testid="task-result-file-read">
			{tooLong ? (
				<Trans>A line alone is longer than the 50 KB a page keeps.</Trans>
			) : from === 0 ? (
				eof && total === 0 ? (
					<Trans>Empty file.</Trans>
				) : (
					<Trans>The offset is past the end of the file.</Trans>
				)
			) : (
				<Trans>
					Lines {from}–{to}
				</Trans>
			)}
			{!tooLong && from > 0 && (eof ? <Trans> (end of file)</Trans> : <Trans> (more lines follow)</Trans>)}
			{!tooLong && from > 0 && eof && total !== null && <Trans>, {total} lines in all</Trans>}
		</p>
	);
}

/** The metadata a file.stat task reported. */
function StatResultView({ result }: { result: Extract<TaskResultView, { kind: "file.stat" }> }) {
	const items: KeyValueItem[] = [
		{ label: <Trans>Path</Trans>, value: result.path, mono: true },
		{ label: <Trans>Type</Trans>, value: result.type },
		{ label: <Trans>Size</Trans>, value: <Plural value={result.size} one="# byte" other="# bytes" /> },
		{ label: <Trans>Mode</Trans>, value: result.mode, mono: true },
		{
			label: <Trans>Owner</Trans>,
			value: result.owner === "" ? String(result.uid) : `${result.owner} (${result.uid})`,
		},
		{
			label: <Trans>Group</Trans>,
			value: result.group === "" ? String(result.gid) : `${result.group} (${result.gid})`,
		},
		{ label: <Trans>Modified</Trans>, value: <DateTime value={result.mtime} /> },
		...(result.linkTarget === null
			? []
			: [{ label: <Trans>Link target</Trans>, value: result.linkTarget, mono: true }]),
	];
	return (
		<div data-testid="task-result-file-stat">
			<KeyValueList items={items} />
		</div>
	);
}

/** The entries a file.list task listed. */
function ListResultView({ result }: { result: Extract<TaskResultView, { kind: "file.list" }> }) {
	return (
		<div className="grid gap-1" data-testid="task-result-file-list">
			<div className="max-h-72 overflow-auto rounded-md border">
				<table className="w-full text-xs">
					<thead className="bg-muted/60 text-muted-foreground">
						<tr>
							<th className="px-2 py-1 text-left font-medium">
								<Trans>Name</Trans>
							</th>
							<th className="px-2 py-1 text-left font-medium">
								<Trans>Type</Trans>
							</th>
							<th className="px-2 py-1 text-right font-medium">
								<Trans>Size</Trans>
							</th>
							<th className="px-2 py-1 text-left font-medium">
								<Trans>Modified</Trans>
							</th>
						</tr>
					</thead>
					<tbody>
						{result.entries.map((entry) => (
							<tr key={entry.name} className="border-t">
								<td className="px-2 py-1 font-mono">{entry.name}</td>
								<td className="px-2 py-1">{entry.type}</td>
								<td className="px-2 py-1 text-right font-mono">{entry.size}</td>
								<td className="px-2 py-1">
									<DateTime value={entry.mtime} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{result.truncated && (
				<p className="text-xs text-muted-foreground">
					<Trans>The listing is truncated: the directory has more entries than are shown.</Trans>
				</p>
			)}
		</div>
	);
}

/**
 * The structured result of a file task (doc/protocol.md TaskResult): what the output streams do not
 * say. A page's lines and end of file, a file's metadata, a directory listing, and what a write or
 * an edit changed.
 */
export function TaskResultData({ result, className }: { result: TaskResultView; className?: string }) {
	return (
		<section aria-label="task result" data-slot="task-result-data" className={cn("grid gap-2", className)}>
			{result.kind === "file.read" ? (
				<ReadResultView result={result} />
			) : result.kind === "file.stat" ? (
				<StatResultView result={result} />
			) : result.kind === "file.list" ? (
				<ListResultView result={result} />
			) : result.kind === "file.write" ? (
				<p className="text-sm text-muted-foreground">
					<Plural value={result.bytes} one="Wrote # byte" other="Wrote # bytes" />
					{result.created ? <Trans> (a new file)</Trans> : <Trans> (replaced)</Trans>}
				</p>
			) : (
				<p className="text-sm text-muted-foreground">
					<Plural value={result.replacements} one="Replaced # occurrence" other="Replaced # occurrences" />
				</p>
			)}
		</section>
	);
}

/**
 * crhs's own line about a task (the SSH privileged notice). It is stored on the task's `notice`
 * and is not part of the output (D114); it is shown separately above the output.
 */
function TaskNotice({ text }: { text: string | null }) {
	if (text === null || text.trim() === "") return null;
	return (
		<p data-testid="task-notice" className="rounded-md border px-2 py-1 font-mono text-xs whitespace-pre-wrap">
			{text.trim()}
		</p>
	);
}

/** The kept output of a task: the single stream's head and tail, or the status-only note. */
export function TaskOutput({ task, className }: { task: TaskView; className?: string }) {
	const { t } = useLingui();
	const output = batchOutput(task);
	const note = statusOutputNoteKey(task);

	return (
		<div data-slot="task-output" className={cn("grid gap-3", className)}>
			<TaskNotice text={task.notice} />
			{output.kind === "status" ? (
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
				<OutputBlock label={t`output`} head={output.head} tail={output.tail} bytes={output.bytes} />
			)}
			{task.result != null && <TaskResultData result={task.result} />}
		</div>
	);
}

/**
 * The full task result used by the approval pages, batch runs, the run panel
 * and the session's tool cards (doc/webui.md "TaskResult"). The task page
 * composes the same parts itself so nothing is shown twice.
 */
export function TaskResult({ task, className }: { task: TaskView; className?: string }) {
	return (
		<div data-slot="task-result" className={cn("grid gap-3", className)}>
			<TaskFacts task={task} />
			<TaskEvaluation task={task} />
			<TaskOutput task={task} />
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
			<TaskStatusBadge state={task.state} />
			<span className="min-w-0 flex-1 truncate font-mono text-xs">{task.summary || task.kind}</span>
			{nodeName !== undefined && <span className="shrink-0">{nodeName}</span>}
			<span className="shrink-0">
				<TaskOutcomeText task={task} />
			</span>
			<RelativeTime value={task.createdAt} className="shrink-0" />
		</Link>
	);
}
