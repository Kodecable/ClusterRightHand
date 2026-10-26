import { api } from "../api.ts";
import { Badge, Loading } from "../components/Feedback.tsx";
import { useLoad } from "../hooks.ts";
import { formatTime, osName } from "../lib.ts";
import { RunPanel } from "./RunPanel.tsx";
import { Shares } from "./Shares.tsx";
import { TaskList } from "./TaskList.tsx";

function factValue(v: unknown): string {
	return typeof v === "string" ? v : JSON.stringify(v);
}

export function NodeDetail({ id }: { id: string }) {
	const node = useLoad(() => api.getNode(id), [id]);
	const tasks = useLoad(() => api.listNodeTasks(id), [id]);
	const n = node.data?.node;
	const canRun = n && n.status === "active" && (n.access === "owner" || n.access === "admin" || n.access === "operate");
	const facts = n?.facts ? Object.entries(n.facts) : [];
	return (
		<>
			<p>
				<a href="#/nodes">← Nodes</a>
			</p>
			<Loading loading={node.loading && !n} error={node.error} />
			{n && (
				<>
					<div className="row">
						<h1>{n.name}</h1>
						<Badge kind={n.status}>{n.status}</Badge>
					</div>
					<dl className="kv">
						<dt>Hostname</dt>
						<dd>{n.hostname ?? "-"}</dd>
						<dt>OS</dt>
						<dd>{osName(n.facts)}</dd>
						<dt>Access</dt>
						<dd>{n.access}</dd>
						<dt>Groups</dt>
						<dd>{n.groups.join(", ") || "-"}</dd>
						<dt>Client</dt>
						<dd>{n.clientVersion ?? "-"}</dd>
						<dt>Last seen</dt>
						<dd>{formatTime(n.lastSeenAt)}</dd>
						<dt>Node id</dt>
						<dd className="mono">{n.id}</dd>
					</dl>
					{facts.length > 0 && (
						<details>
							<summary>Facts ({facts.length})</summary>
							<dl className="kv">
								{facts.map(([k, v]) => (
									<div key={k} className="kv-row">
										<dt>{k}</dt>
										<dd className="mono">{factValue(v)}</dd>
									</div>
								))}
							</dl>
						</details>
					)}
					{canRun && <RunPanel nodeId={n.id} onDone={tasks.reload} />}
					{node.data?.shares && <Shares nodeId={n.id} shares={node.data.shares} onChange={node.reload} />}
					<section>
						<div className="row">
							<h2>Recent tasks</h2>
							<span className="spacer" />
							<button type="button" onClick={tasks.reload}>
								Refresh
							</button>
						</div>
						<Loading loading={tasks.loading && !tasks.data} error={tasks.error} />
						{tasks.data && <TaskList tasks={tasks.data} />}
					</section>
				</>
			)}
		</>
	);
}
