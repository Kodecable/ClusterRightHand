import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, type PublicNode, type TaskGroupView } from "../api.ts";
import { DecisionView } from "../components/Approval.tsx";
import { Badge, ErrorText, Loading } from "../components/Feedback.tsx";
import { TaskFormFields } from "../components/TaskFormFields.tsx";
import { stateKind, TaskResult } from "../components/TaskResult.tsx";
import { errMsg, useLoad } from "../hooks.ts";
import { buildTargets, taskOutcome } from "../lib.ts";
import { buildTaskRequest, emptyForm, type TaskForm } from "../taskForm.ts";

const canOperate = (n: PublicNode) => n.status === "active" && n.access !== "view";

export function groupStateKind(state: string): string {
	if (state === "finished") return "ok";
	if (state === "rejected" || state === "interrupted") return "bad";
	return "busy";
}

function GroupResult({ group, names }: { group: TaskGroupView; names: Map<string, string> }) {
	const name = (id: string) => names.get(id) ?? id;
	return (
		<section>
			<h2>
				Result <Badge kind={groupStateKind(group.state)}>{group.state}</Badge>
			</h2>
			{group.state === "awaiting_approval" && (
				<p>
					Waiting for approval. <a href={`#/approvals/task-groups/${group.id}`}>Open approval page</a>
				</p>
			)}
			{group.state === "rejected" && group.approval?.decision && <DecisionView decision={group.approval.decision} />}
			<div className="scroll-x">
				<table>
					<thead>
						<tr>
							<th>Node</th>
							<th>State</th>
							<th>Outcome</th>
							<th>Output</th>
						</tr>
					</thead>
					<tbody>
						{group.tasks.map((t) => (
							<tr key={t.id}>
								<td>
									<a href={`#/nodes/${t.nodeId}`}>{name(t.nodeId)}</a>
								</td>
								<td>
									<Badge kind={stateKind(t)}>{t.state}</Badge>
								</td>
								<td>{taskOutcome(t)}</td>
								<td>
									<details>
										<summary>Show</summary>
										<TaskResult task={t} />
									</details>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{group.skipped.length > 0 && (
				<p className="muted">
					Skipped: {group.skipped.map(name).join(", ")}
					{group.state === "interrupted" && " (batch interrupted)"}
				</p>
			)}
		</section>
	);
}

export function Batch() {
	const nodes = useLoad(() => api.listNodes(), []);
	const [form, setForm] = useState<TaskForm>(emptyForm);
	const [picked, setPicked] = useState<string[]>([]);
	const [extra, setExtra] = useState("");
	const [parallel, setParallel] = useState("");
	const [failFast, setFailFast] = useState(false);
	const [outputMode, setOutputMode] = useState<"status" | "text">("status");
	const [group, setGroup] = useState<TaskGroupView>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const abort = useRef<AbortController>(undefined);
	useEffect(() => () => abort.current?.abort(), []);

	const operable = (nodes.data ?? []).filter(canOperate);
	const names = new Map((nodes.data ?? []).map((n) => [n.id, n.name]));
	const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setError(undefined);
		abort.current?.abort();
		const ctl = new AbortController();
		abort.current = ctl;
		setBusy(true);
		try {
			const targets = buildTargets(picked, extra);
			if (targets.length === 0) throw new Error("choose at least one target");
			const p = parallel.trim() === "" ? undefined : Number(parallel);
			if (p !== undefined && (!Number.isSafeInteger(p) || p < 1))
				throw new Error("parallel must be a positive integer");
			let g = await api.createTaskGroup({
				...buildTaskRequest(form),
				waitMs: 0,
				targets,
				failFast,
				outputMode,
				...(p !== undefined ? { parallel: p } : {}),
			});
			setGroup(g);
			while ((g.state === "running" || g.state === "awaiting_approval") && !ctl.signal.aborted) {
				g = await api.waitTaskGroup(g.id, 20000, ctl.signal);
				setGroup(g);
			}
		} catch (err) {
			if (!ctl.signal.aborted) setError(errMsg(err));
		}
		if (!ctl.signal.aborted) setBusy(false);
	};

	return (
		<>
			<h1>Batch run</h1>
			<form onSubmit={submit} className="stack">
				<fieldset>
					<legend>Targets</legend>
					<Loading loading={nodes.loading && !nodes.data} error={nodes.error} />
					<div className="pick">
						{operable.map((n) => (
							<label key={n.id} className="inline">
								<input type="checkbox" checked={picked.includes(n.name)} onChange={() => toggle(n.name)} /> {n.name}
								{n.transport === "ssh" && <Badge kind="ssh">SSH</Badge>}
							</label>
						))}
					</div>
					{nodes.data && operable.length === 0 && <p className="muted">No active nodes you can operate.</p>}
					<label>
						Groups or raw targets (comma separated, e.g. group:web, node-1)
						<input value={extra} onChange={(e) => setExtra(e.target.value)} />
					</label>
				</fieldset>
				<TaskFormFields form={form} onChange={setForm} />
				<div className="row wrap">
					<label>
						Parallel
						<input
							value={parallel}
							inputMode="numeric"
							size={6}
							placeholder="10"
							onChange={(e) => setParallel(e.target.value)}
						/>
					</label>
					<label className="inline">
						<input type="checkbox" checked={failFast} onChange={(e) => setFailFast(e.target.checked)} /> fail fast
					</label>
					<label>
						Output
						<select value={outputMode} onChange={(e) => setOutputMode(e.target.value as "status" | "text")}>
							<option value="status">Status only</option>
							<option value="text">Tail of output</option>
						</select>
					</label>
				</div>
				<ErrorText error={error} />
				<div className="row">
					<button type="submit" className="primary" disabled={busy}>
						{buildTargets(picked, extra).length === 0
							? "Choose targets"
							: `Run on ${buildTargets(picked, extra).length} target(s)`}
					</button>
				</div>
			</form>
			{group && <GroupResult group={group} names={names} />}
		</>
	);
}
