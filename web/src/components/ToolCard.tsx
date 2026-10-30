import { approvalWait, authorizationWait, prettyJson, safeHashLink, type TranscriptItem } from "../sessionState.ts";
import { Badge } from "./Feedback.tsx";
import { stateKind } from "./TaskResult.tsx";

type Tool = Extract<TranscriptItem, { kind: "tool" }>;

function ResultText({ text, isError }: { text: string; isError: boolean }) {
	const parsed = prettyJson(text);
	const value = parsed && !Array.isArray(parsed.value) ? parsed.value : undefined;
	const state = typeof value?.state === "string" ? value.state : undefined;
	const exit = typeof value?.exit_code === "number" ? value.exit_code : undefined;
	return (
		<div className="stack">
			{(state !== undefined || exit !== undefined) && (
				<div className="row wrap">
					{state !== undefined && (
						<span>
							state <Badge kind={stateKind({ state, exitCode: exit ?? null, signal: "" })}>{state}</Badge>
						</span>
					)}
					{exit !== undefined && (
						<span>
							exit_code <Badge kind={exit === 0 ? "ok" : "warn"}>{String(exit)}</Badge>
						</span>
					)}
				</div>
			)}
			<pre className={`output${isError ? " error" : ""}`}>{parsed ? parsed.pretty : text}</pre>
		</div>
	);
}

export function ToolCard({ tool, running }: { tool: Tool; running: boolean }) {
	const wait = tool.result ? undefined : approvalWait(tool.details);
	const link = wait && safeHashLink(wait.url);
	const signature = tool.result ? undefined : authorizationWait(tool.details);
	const signatureLink = signature && safeHashLink(signature.url);
	const details = tool.details as { sessionId?: unknown } | undefined;
	const subagent = typeof details?.sessionId === "string" ? details.sessionId : undefined;
	const hasArgs = Object.keys(tool.args).length > 0;
	const status = tool.result
		? tool.result.isError
			? "failed"
			: "done"
		: running
			? tool.status === "pending"
				? "preparing"
				: "running"
			: "no result";
	return (
		<section className="card tool" aria-label={`Tool call ${tool.name}`}>
			<div className="row wrap">
				<strong className="mono">{tool.name}</strong>
				<Badge kind={status === "done" ? "ok" : status === "failed" ? "bad" : status === "no result" ? "off" : "busy"}>
					{status}
				</Badge>
			</div>
			{hasArgs && (
				<details open>
					<summary>Arguments</summary>
					<pre className="output">{JSON.stringify(tool.args, null, 2)}</pre>
				</details>
			)}
			{wait && (
				<p className="warn" role="status">
					Waiting for your approval.{" "}
					{link ? <a href={link}>Review and approve</a> : <span className="muted">Open the Approvals page.</span>}
				</p>
			)}
			{signature && (
				<p className="warn" role="status">
					Waiting for your signature.{" "}
					{signatureLink ? (
						<a href={signatureLink}>Open the signing page</a>
					) : (
						<span className="muted">Open the task page.</span>
					)}
				</p>
			)}
			{!tool.result && tool.output && (
				<details open>
					<summary>Output so far</summary>
					<pre className="output">{tool.output}</pre>
				</details>
			)}
			{subagent && (
				<p>
					<a href={`#/sessions/${encodeURIComponent(subagent)}`}>Open the subagent's session</a>
				</p>
			)}
			{tool.result && <ResultText text={tool.result.text} isError={tool.result.isError} />}
		</section>
	);
}
