import { type FormEvent, useState } from "react";
import { api, type GranteeType, type NodeShare, type ShareAccess } from "../api.ts";
import { ErrorText } from "../components/Feedback.tsx";
import { useAction, useDirectory } from "../hooks.ts";

export function Shares({ nodeId, shares, onChange }: { nodeId: string; shares: NodeShare[]; onChange: () => void }) {
	const [type, setType] = useState<GranteeType>("user");
	const [id, setId] = useState("");
	const [access, setAccess] = useState<ShareAccess>("view");
	const { busy, error, run } = useAction();
	const dir = useDirectory();
	const options =
		type === "user"
			? dir.users.map((u) => ({ id: u.id, label: u.displayName || u.username }))
			: dir.userGroups.map((g) => ({ id: g.id, label: g.name }));
	const add = async (e: FormEvent) => {
		e.preventDefault();
		if (await run(() => api.shareNode(nodeId, type, id.trim(), access))) {
			setId("");
			onChange();
		}
	};
	const remove = async (shareId: string) => {
		if (await run(() => api.unshareNode(nodeId, shareId))) onChange();
	};
	return (
		<section aria-label="Shares">
			<h2>Shares</h2>
			{shares.length > 0 ? (
				<table>
					<thead>
						<tr>
							<th>Grantee</th>
							<th>Access</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{shares.map((s) => (
							<tr key={s.id}>
								<td>
									{s.granteeType === "user" ? "user" : "group"}{" "}
									{s.granteeName || <span className="mono">{s.granteeId}</span>}
								</td>
								<td>{s.access}</td>
								<td className="actions">
									<button type="button" className="danger" disabled={busy} onClick={() => remove(s.id)}>
										Remove
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<p className="muted">Not shared.</p>
			)}
			<form onSubmit={add} className="row wrap">
				<label>
					Type
					<select
						value={type}
						onChange={(e) => {
							setType(e.target.value as GranteeType);
							setId("");
						}}
					>
						<option value="user">user</option>
						<option value="user_group">user group</option>
					</select>
				</label>
				<label>
					Grantee
					<select value={id} onChange={(e) => setId(e.target.value)} required>
						<option value="">Select…</option>
						{options.map((o) => (
							<option key={o.id} value={o.id}>
								{o.label}
							</option>
						))}
					</select>
				</label>
				<label>
					Access
					<select value={access} onChange={(e) => setAccess(e.target.value as ShareAccess)}>
						<option value="view">view</option>
						<option value="operate">operate</option>
					</select>
				</label>
				<button type="submit" disabled={busy}>
					Add share
				</button>
			</form>
			<ErrorText error={error} />
		</section>
	);
}
