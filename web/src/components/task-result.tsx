import type { TaskResultView, TaskView } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CopyButton } from "@/components/copy-button";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { type KeyValueItem, KeyValueList } from "@/components/key-value";
import { DateTime, RelativeTime } from "@/components/relative-time";
import { TaskStatusBadge } from "@/components/status-badge";
import { TaskOutcomeBadge } from "@/components/task-outcome";
import { useTimeColumnWidth } from "@/components/time-column";
import { batchOutput, joinOutput, statusOutputNoteKey } from "@/lib/task-output";
import { taskTitle } from "@/lib/task-title";
import { cn, MONO_CELL } from "@/lib/utils";
import { EvaluationTable } from "./decision/evaluation";
import { TaskFacts } from "./task-facts";

export { TaskFacts, TaskGroupFacts } from "./task-facts";

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
	const { t } = useLingui();
	if (bytes === 0 && head === "" && tail === "") return null;
	const { before, after, omitted } = joinOutput(head, tail, bytes);
	return (
		<section aria-label={label} className={cn("grid gap-1", className)}>
			<div className="flex items-center justify-between gap-2">
				<h4 className="text-xs font-medium text-muted-foreground">
					{label}
					{" · "}
					<Plural value={bytes} one="# byte" other="# bytes" />
				</h4>
				<CopyButton text={before + after} label={t`Copy ${label}`} />
			</div>
			<pre className="max-h-72 overflow-auto rounded-md border bg-[var(--code)] p-2 font-mono text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
				{before}
				{omitted > 0 && (
					<span className="text-warn">
						{"\n"}
						<Trans>
							… <Plural value={omitted} one="# byte" other="# bytes" /> omitted …
						</Trans>
						{"\n"}
					</span>
				)}
				{after}
			</pre>
		</section>
	);
}

/**
 * The rule chain that produced an approval decision, folded away. Shown for any
 * task with an approval record, whatever its state: a finished task keeps the
 * chain that was evaluated. The task page hides it while awaiting approval,
 * where the approval card shows the same chain.
 */
export function TaskEvaluation({
	task,
	tokenNames,
	className,
}: {
	task: TaskView;
	tokenNames?: Map<string, string>;
	className?: string;
}) {
	if (!task.approval) return null;
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

/** A page's line range and whether the scan reached the end of the file (doc/design/protocol.md "Task results"). */
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
			) : eof ? (
				total === null ? (
					<Trans>
						Lines {from}–{to} (end of file)
					</Trans>
				) : (
					<Trans>
						Lines {from}–{to} (end of file), <Plural value={total} one="# line in all" other="# lines in all" />
					</Trans>
				)
			) : (
				<Trans>
					Lines {from}–{to} (more lines follow)
				</Trans>
			)}
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
	const { t } = useLingui();
	const timeWidth = useTimeColumnWidth("compact");
	const columns: DataTableColumn<(typeof result.entries)[number]>[] = [
		{
			id: "name",
			header: t`Name`,
			minSize: 160,
			cell: ({ row }) => <span className={MONO_CELL}>{row.original.name}</span>,
			meta: { title: (entry: (typeof result.entries)[number]) => entry.name },
		},
		{ id: "type", header: t`Type`, size: 90, cell: ({ row }) => row.original.type },
		{
			id: "size",
			header: t`Size`,
			size: 100,
			cell: ({ row }) => <span className={MONO_CELL}>{row.original.size}</span>,
		},
		{
			id: "modified",
			header: t`Modified`,
			size: timeWidth,
			cell: ({ row }) => <DateTime value={row.original.mtime} />,
		},
	];
	return (
		<div className="grid gap-1" data-testid="task-result-file-list">
			<DataTable
				label={t`Directory listing`}
				columns={columns}
				data={[...result.entries]}
				getRowId={(entry) => entry.name}
				density="compact"
				className="max-h-72 overflow-auto"
			/>
			{result.truncated && (
				<p className="text-xs text-muted-foreground">
					<Trans>The listing is truncated: the directory has more entries than are shown.</Trans>
				</p>
			)}
		</div>
	);
}

/**
 * The structured result of a file task (doc/design/protocol.md "Task results"): what the output streams do not
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
					{result.created ? (
						<Plural value={result.bytes} one="Wrote # byte (a new file)" other="Wrote # bytes (a new file)" />
					) : (
						<Plural value={result.bytes} one="Wrote # byte (replaced)" other="Wrote # bytes (replaced)" />
					)}
				</p>
			) : result.kind === "file.pull" ? (
				<p className="text-sm text-muted-foreground" data-testid="task-result-file-pull">
					<Trans>
						Received <Plural value={result.size} one="# byte" other="# bytes" />, SHA-256{" "}
						<code className="font-mono text-xs break-all">{result.sha256}</code>
					</Trans>
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
 * and is not part of the output; it is shown separately above the output.
 */
function TaskNotice({ text }: { text: string | null }) {
	if (text === null || text.trim() === "") return null;
	return (
		<p
			data-testid="task-notice"
			className="rounded-md border px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap [overflow-wrap:anywhere]"
		>
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
					{output.file !== null ? (
						<Trans>
							Status only. The full output is in <span className="font-mono text-xs">{output.file}</span> on the node.
						</Trans>
					) : note === "running" ? (
						<Trans>Status only. The full output stays on the node until the task exits.</Trans>
					) : note === "none" ? (
						<Trans>Status only. No output was kept.</Trans>
					) : (
						<Trans>Status only. No output is kept (SSH nodes keep no output).</Trans>
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
 * Whether `TaskOutput` renders anything: a notice, kept output, the status-only
 * note (it always explains itself), or a structured result. The task page uses
 * it to skip the Result box of a task with nothing to show (a failed task with
 * no output).
 */
export function hasTaskOutput(task: TaskView): boolean {
	if (task.notice !== null && task.notice.trim() !== "") return true;
	const output = batchOutput(task);
	if (output.kind === "status") return true;
	if (output.bytes !== 0 || output.head !== "" || output.tail !== "") return true;
	return task.result != null;
}

/**
 * The full task result used by the approval pages, batch runs, the run panel
 * and the session's tool cards (doc/design/webui.md "Shared components"). The task page
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
	const { i18n } = useLingui();
	return (
		<Link
			to="/tasks/$taskId"
			params={{ taskId: task.id }}
			data-slot="task-summary"
			data-testid="task-summary"
			className={cn("flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent", className)}
		>
			<TaskStatusBadge state={task.state} />
			<span className={cn("min-w-0 flex-1 truncate", MONO_CELL)}>{taskTitle(i18n, task)}</span>
			{nodeName !== undefined && <span className="shrink-0">{nodeName}</span>}
			<span className="shrink-0">
				<TaskOutcomeBadge outcome={task.outcome} />
			</span>
			<RelativeTime value={task.createdAt} className="shrink-0" />
		</Link>
	);
}
