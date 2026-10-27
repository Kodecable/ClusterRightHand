import { type FormEvent, useCallback, useState } from "react";
import {
	type ApiTokenView,
	api,
	type Evaluation,
	type PublicNode,
	type Rule,
	type TaskGroupView,
	type TaskView,
} from "../api.ts";
import { DecisionView, EvaluationView } from "../components/Approval.tsx";
import { Badge, ErrorText, Loading } from "../components/Feedback.tsx";
import { stateKind } from "../components/TaskResult.tsx";
import { errMsg, useLoad, usePolling } from "../hooks.ts";
import { actorLabel, alwaysRule, formatTime } from "../lib.ts";

/** Fired after a decision so that the header's pending count refreshes at once. */
export const APPROVALS_CHANGED = "crh:approvals-changed";

type Item = { kind: "task"; task: TaskView } | { kind: "group"; group: TaskGroupView };

interface Lookups {
	nodeNames: Map<string, string>;
	tokenNames: Map<string, string>;
}

function useLookups(): Lookups {
	const nodes = useLoad(() => api.listNodes(), []);
	const tokens = useLoad(() => api.listApiTokens(), []);
	return {
		nodeNames: new Map((nodes.data ?? []).map((n: PublicNode) => [n.id, n.name])),
		tokenNames: new Map((tokens.data ?? []).map((t: ApiTokenView) => [t.id, t.name])),
	};
}

function AlwaysAllow({
	item,
	lookups,
	onSubmit,
	busy,
}: {
	item: Item;
	lookups: Lookups;
	onSubmit: (rule: Rule) => void;
	busy: boolean;
}) {
	const operation = item.kind === "task" ? item.task.operation : item.group.operation;
	const nodeName =
		item.kind === "task"
			? (lookups.nodeNames.get(item.task.nodeId) ?? item.task.nodeId)
			: (item.group.approval?.nodes
					.filter((n) => n.evaluation.result === "require-approval")
					.map((n) => lookups.nodeNames.get(n.nodeId) ?? n.nodeId)
					.join(",") ?? "");
	const nodeList = nodeName.split(",").filter(Boolean);
	const [mode, setMode] = useState<"exact" | "prefix">("exact");
	const build = (m: "exact" | "prefix") => {
		const rule = alwaysRule(operation, nodeList, m);
		return rule ? JSON.stringify(rule, null, 2) : "";
	};
	const [text, setText] = useState(() => build("exact"));
	const [error, setError] = useState<string>();
	const submit = (e: FormEvent) => {
		e.preventDefault();
		try {
			const rule = JSON.parse(text) as Rule;
			if (typeof rule !== "object" || rule === null || Array.isArray(rule)) throw new Error("expected a rule object");
			setError(undefined);
			onSubmit(rule);
		} catch (err) {
			setError(`Not a valid rule: ${errMsg(err)}`);
		}
	};
	return (
		<form onSubmit={submit} className="stack" aria-label="Always allow rule">
			<div className="row wrap">
				<label className="inline">
					<input
						type="radio"
						name="always-mode"
						checked={mode === "exact"}
						onChange={() => {
							setMode("exact");
							setText(build("exact"));
						}}
					/>{" "}
					exact
				</label>
				<label className="inline">
					<input
						type="radio"
						name="always-mode"
						checked={mode === "prefix"}
						onChange={() => {
							setMode("prefix");
							setText(build("prefix"));
						}}
					/>{" "}
					prefix
				</label>
			</div>
			<label>
				Rule to add to the token
				<textarea className="mono" rows={7} value={text} onChange={(e) => setText(e.target.value)} />
			</label>
			<ErrorText error={error} />
			<div className="row">
				<button type="submit" className="primary" disabled={busy}>
					Approve and always allow
				</button>
			</div>
		</form>
	);
}

function Card({ item, lookups, onSettled }: { item: Item; lookups: Lookups; onSettled: () => void }) {
	const [reason, setReason] = useState("");
	const [always, setAlways] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const subject = item.kind === "task" ? item.task : item.group;
	const id = subject.id;
	const decide = async (decision: "approve" | "reject", rule?: Rule) => {
		setBusy(true);
		setError(undefined);
		const body = {
			decision,
			...(decision === "reject" && reason.trim() ? { reason: reason.trim() } : {}),
			...(rule ? { always: rule } : {}),
		};
		try {
			if (item.kind === "task") await api.decideTask(id, body);
			else await api.decideTaskGroup(id, body);
			window.dispatchEvent(new Event(APPROVALS_CHANGED));
			onSettled();
		} catch (e) {
			setError(errMsg(e));
			if (e instanceof Error && "status" in e && (e as { status: number }).status === 409) onSettled();
		} finally {
			setBusy(false);
		}
	};
	const what =
		item.kind === "task"
			? `${item.task.kind} on ${lookups.nodeNames.get(item.task.nodeId) ?? item.task.nodeId}`
			: `${item.group.kind ?? "task group"} on ${item.group.nodeIds.length} node(s): ${item.group.nodeIds
					.map((n) => lookups.nodeNames.get(n) ?? n)
					.join(", ")}`;
	const heading = item.kind === "task" ? "Task" : "Task group";

	const evaluations: { label?: string; evaluation: Evaluation }[] =
		item.kind === "task"
			? item.task.approval
				? [{ evaluation: item.task.approval.evaluation }]
				: []
			: (item.group.approval?.nodes ?? []).map((n) => ({
					label: lookups.nodeNames.get(n.nodeId) ?? n.nodeId,
					evaluation: n.evaluation,
				}));
	return (
		<section className="card" aria-label={`${heading} ${id}`}>
			<h2>
				{heading} <span className="mono">{id}</span>
			</h2>
			<dl className="kv">
				<dt>What</dt>
				<dd>{what}</dd>
				<dt>Command / path</dt>
				<dd className="mono">{item.kind === "task" ? item.task.summary : item.group.summary}</dd>
				{item.kind === "task" && (
					<>
						<dt>Asked by</dt>
						<dd>{actorLabel(item.task.actorType, item.task.actorId, lookups.tokenNames)}</dd>
					</>
				)}
				{item.kind === "group" && (
					<>
						<dt>Asked by</dt>
						<dd>
							{item.group.actorType && item.group.actorId
								? actorLabel(item.group.actorType, item.group.actorId, lookups.tokenNames)
								: "-"}
						</dd>
					</>
				)}
				<dt>Requested</dt>
				<dd>{formatTime(subject.createdAt)}</dd>
			</dl>
			{evaluations.map((e) => (
				<div key={e.label ?? "task"}>
					{e.label && <h3>{e.label}</h3>}
					<EvaluationView evaluation={e.evaluation} tokenNames={lookups.tokenNames} />
				</div>
			))}
			<label>
				Reason (optional, used when rejecting)
				<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
			</label>
			<div className="row wrap">
				<button type="button" className="primary" disabled={busy} onClick={() => decide("approve")}>
					Approve
				</button>
				<button type="button" disabled={busy} onClick={() => setAlways((a) => !a)} aria-expanded={always}>
					Approve and always allow…
				</button>
				<button type="button" className="danger" disabled={busy} onClick={() => decide("reject")}>
					Reject
				</button>
			</div>
			{always && <AlwaysAllow item={item} lookups={lookups} busy={busy} onSubmit={(rule) => decide("approve", rule)} />}
			<ErrorText error={error} />
		</section>
	);
}

export function Approvals() {
	const { data, error, loading, reload } = useLoad(() => api.listApprovals(), []);
	usePolling(reload, 5000);
	const lookups = useLookups();
	const count = (data?.tasks.length ?? 0) + (data?.taskGroups.length ?? 0);
	return (
		<>
			<h1>Approvals</h1>
			<Loading loading={loading && !data} error={error} />
			{data && count === 0 && <p className="muted">Nothing is waiting for your approval.</p>}
			{data?.tasks.map((task) => (
				<Card key={task.id} item={{ kind: "task", task }} lookups={lookups} onSettled={reload} />
			))}
			{data?.taskGroups.map((group) => (
				<Card key={group.id} item={{ kind: "group", group }} lookups={lookups} onSettled={reload} />
			))}
		</>
	);
}

/** One approval, from a link such as the ones MCP returns. */
export function ApprovalDetail({ kind, id }: { kind: "tasks" | "task-groups"; id: string }) {
	const load = useCallback(
		async (): Promise<Item> =>
			kind === "tasks"
				? { kind: "task", task: await api.getTask(id) }
				: { kind: "group", group: await api.getTaskGroup(id) },
		[kind, id],
	);
	const { data, error, loading, reload } = useLoad(load, [load]);
	usePolling(reload, 5000);
	const lookups = useLookups();
	const subject = data && (data.kind === "task" ? data.task : data.group);
	const pending = subject?.state === "awaiting_approval";
	const target = kind === "tasks" ? `#/tasks/${id}` : "#/batch";
	return (
		<>
			<p>
				<a href="#/approvals">← Approvals</a>
			</p>
			<Loading loading={loading && !data} error={error} />
			{data && subject && pending && <Card item={data} lookups={lookups} onSettled={reload} />}
			{data && subject && !pending && (
				<section aria-label="Already settled">
					<h1>Already settled</h1>
					<p>
						This {kind === "tasks" ? "task" : "task group"} is no longer waiting for approval; it is{" "}
						<Badge kind={data.kind === "task" ? stateKind(data.task) : "off"}>{subject.state}</Badge>.
					</p>
					{data.kind === "task" && data.task.approval?.decision && (
						<DecisionView decision={data.task.approval.decision} />
					)}
					{data.kind === "group" && data.group.approval?.decision && (
						<DecisionView decision={data.group.approval.decision} />
					)}
					<p>
						{kind === "tasks" ? <a href={target}>Open the task</a> : <span className="muted">Task group {id}</span>}
					</p>
				</section>
			)}
		</>
	);
}
