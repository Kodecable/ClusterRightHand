import { useState } from "react";
import { api, type PublicNode } from "../api.ts";
import { useUser } from "../auth.tsx";
import { Badge, ErrorText, LinkBadge, Loading } from "../components/Feedback.tsx";
import { Modal } from "../components/Modal.tsx";
import { useAction, useLoad, usePolling } from "../hooks.ts";
import { formatTime, osName } from "../lib.ts";
import { AddNodeDialog } from "./AddNodeDialog.tsx";
import { AddSshNodeDialog } from "./AddSshNodeDialog.tsx";

type Pending = { node: PublicNode; action: "approve" | "reject" };

function ConfirmPending({ p, onClose, onDone }: { p: Pending; onClose: () => void; onDone: () => void }) {
	const { busy, error, run } = useAction();
	const approve = p.action === "approve";
	const go = async () => {
		const ok = await run(async () => {
			if (approve) await api.approveNode(p.node.id);
			else await api.deleteNode(p.node.id);
			return true;
		});
		if (ok) onDone();
	};
	return (
		<Modal title={approve ? "Approve node" : "Reject node"} onClose={onClose}>
			<div className="stack">
				<p>
					{approve ? "Approve" : "Reject and delete"} <strong>{p.node.hostname ?? p.node.name}</strong>
					{p.node.hostname && p.node.hostname !== p.node.name && <> (named {p.node.name})</>}?
				</p>
				{approve && (
					<>
						<p>
							Node key fingerprint: <code>{p.node.keyFingerprint ?? "unknown"}</code>
						</p>
						<p className="muted">
							It must match what <code>crha enroll</code> printed, or <code>crha status</code> on the node, before you
							approve.
						</p>
					</>
				)}
				<ErrorText error={error} />
				<div className="row end">
					<button type="button" className={approve ? "primary" : "danger"} onClick={go} disabled={busy}>
						{approve ? "Approve" : "Reject"}
					</button>
					<button type="button" onClick={onClose}>
						Cancel
					</button>
				</div>
			</div>
		</Modal>
	);
}

export function Nodes() {
	const user = useUser();
	const { data, error, loading, reload } = useLoad(() => api.listNodes(), []);
	// New pending nodes and online/offline changes show up without pressing Refresh.
	usePolling(reload);
	const [adding, setAdding] = useState(false);
	const [addingSsh, setAddingSsh] = useState(false);
	const [pending, setPending] = useState<Pending>();
	const canDecide = (n: PublicNode) => n.status === "pending" && (n.access === "owner" || user.kind === "admin");
	return (
		<>
			<div className="row">
				<h1>Nodes</h1>
				<span className="spacer" />
				<button type="button" onClick={reload}>
					Refresh
				</button>
				<button type="button" onClick={() => setAddingSsh(true)}>
					Add SSH node
				</button>
				<button type="button" className="primary" onClick={() => setAdding(true)}>
					Add node
				</button>
			</div>
			<Loading loading={loading && !data} error={error} />
			{data && (
				<div className="scroll-x">
					<table>
						<thead>
							<tr>
								<th>Name</th>
								<th>Status</th>
								<th>Hostname</th>
								<th>OS</th>
								<th>Groups</th>
								<th>Access</th>
								<th>Last seen</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{data.map((n) => (
								<tr key={n.id}>
									<td>
										<a href={`#/nodes/${n.id}`}>{n.name}</a>
										{n.transport === "ssh" && (
											<>
												{" "}
												<Badge kind="ssh">SSH</Badge>
											</>
										)}
									</td>
									<td>
										<Badge kind={n.status}>{n.status}</Badge>{" "}
										{n.status === "active" && <LinkBadge connected={n.connected} />}
										{n.clockWarning && (
											<>
												{" "}
												<span className="warn" title={n.clockWarning}>
													⚠ clock
												</span>
											</>
										)}
									</td>
									<td>{n.hostname ?? "-"}</td>
									<td>{osName(n.facts)}</td>
									<td>{n.groups.join(", ") || "-"}</td>
									<td>{n.access}</td>
									<td>{formatTime(n.lastSeenAt)}</td>
									<td className="actions">
										{canDecide(n) && (
											<>
												<button
													type="button"
													className="primary"
													onClick={() => setPending({ node: n, action: "approve" })}
												>
													Approve
												</button>
												<button
													type="button"
													className="danger"
													onClick={() => setPending({ node: n, action: "reject" })}
												>
													Reject
												</button>
											</>
										)}
									</td>
								</tr>
							))}
							{data.length === 0 && (
								<tr>
									<td colSpan={8} className="muted">
										No nodes yet. Use "Add node" to enroll one.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			)}
			{adding && (
				<AddNodeDialog
					onClose={() => {
						setAdding(false);
						reload();
					}}
				/>
			)}
			{addingSsh && (
				<AddSshNodeDialog
					onClose={() => {
						setAddingSsh(false);
						reload();
					}}
				/>
			)}
			{pending && (
				<ConfirmPending
					p={pending}
					onClose={() => setPending(undefined)}
					onDone={() => {
						setPending(undefined);
						reload();
					}}
				/>
			)}
		</>
	);
}
