import type { TaskView } from "../api.ts";
import { batchOutput, formatTime, isTerminal, joinOutput, statusOutputNote } from "../lib.ts";
import { DecisionView, EvaluationView } from "./Approval.tsx";
import { Badge } from "./Feedback.tsx";

export function OutputBlock({
	label,
	head,
	tail,
	bytes,
}: {
	label: string;
	head: string;
	tail: string;
	bytes: number;
}) {
	if (bytes === 0 && !head && !tail) return null;
	const { before, after, omitted } = joinOutput(head, tail, bytes);
	return (
		<section aria-label={label}>
			<h4>
				{label} <span className="muted">({bytes} bytes)</span>
			</h4>
			<pre className="output">
				{before}
				{omitted > 0 && <span className="omitted">{`\n… ${omitted} bytes omitted …\n`}</span>}
				{after}
			</pre>
		</section>
	);
}

/** Badge kind: a non-zero exit is the command's own failure (warn), not the platform's (bad). */
export function stateKind(task: Pick<TaskView, "state" | "exitCode" | "signal">): string {
	if (task.state === "exited") return task.exitCode === 0 && !task.signal ? "ok" : "warn";
	if (task.state === "awaiting_approval") return "busy";
	if (isTerminal(task.state)) return "bad";
	return "busy";
}

export function TaskResult({ task }: { task: TaskView }) {
	const output = batchOutput(task);
	return (
		<div className="task-result">
			<dl className="kv">
				<dt>Task</dt>
				<dd className="mono">{task.id}</dd>
				<dt>Kind</dt>
				<dd>{task.kind}</dd>
				{task.summary && (
					<>
						<dt>Summary</dt>
						<dd className="mono">{task.summary}</dd>
					</>
				)}
				<dt>State</dt>
				<dd>
					<Badge kind={stateKind(task)}>{task.state}</Badge>
					{task.timedOut && " timed out"}
					{task.cancelled && " cancelled"}
				</dd>
				{task.exitCode !== null && (
					<>
						<dt>Exit code</dt>
						<dd>{task.exitCode}</dd>
					</>
				)}
				{task.signal && (
					<>
						<dt>Signal</dt>
						<dd>{task.signal}</dd>
					</>
				)}
				{(task.errorCode || task.errorMessage) && (
					<>
						<dt>Error</dt>
						<dd className="error">
							{task.errorCode} {task.errorMessage}
						</dd>
					</>
				)}
				{task.state === "awaiting_approval" && (
					<>
						<dt>Approval</dt>
						<dd>
							Waiting for approval. <a href={`#/approvals/tasks/${task.id}`}>Open approval page</a>
						</dd>
					</>
				)}
				{task.approval?.decision && (
					<>
						<dt>Approval decision</dt>
						<dd>
							<DecisionView decision={task.approval.decision} />
						</dd>
					</>
				)}
				<dt>Created</dt>
				<dd>{formatTime(task.createdAt)}</dd>
				<dt>Finished</dt>
				<dd>{formatTime(task.finishedAt)}</dd>
				{task.outputFile && (
					<>
						<dt>Output file</dt>
						<dd className="mono">{task.outputFile}</dd>
					</>
				)}
			</dl>
			{task.approval && task.state !== "exited" && (
				<details>
					<summary>Rule chain evaluation</summary>
					<EvaluationView evaluation={task.approval.evaluation} />
				</details>
			)}
			{output.kind === "tail" ? (
				<OutputBlock label="output" head="" tail={output.text} bytes={output.bytes} />
			) : output.kind === "status" ? (
				<p className="muted">
					Status only;{" "}
					{output.file ? (
						<>
							the full output is in <span className="mono">{output.file}</span> on the node.
						</>
					) : (
						statusOutputNote(task)
					)}
				</p>
			) : (
				<>
					<OutputBlock label="stdout" head={task.stdoutHead} tail={task.stdoutTail} bytes={task.stdoutBytes} />
					<OutputBlock label="stderr" head={task.stderrHead} tail={task.stderrTail} bytes={task.stderrBytes} />
				</>
			)}
		</div>
	);
}
