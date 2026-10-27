import { type FormEvent, useState } from "react";
import { api, type GranteeType, type NodeShare, type SessionShare } from "../api.ts";
import { ErrorText } from "../components/Feedback.tsx";
import { useAction, useDirectory } from "../hooks.ts";

/** What a share row must show, whichever kind of resource it belongs to. */
interface ShareRow {
	id: string;
	granteeType: GranteeType;
	granteeId: string;
	granteeName: string | null;
	access: string;
}
type ShareTarget = "node" | "session";
type Access = "view" | "operate" | "chat";

/**
 * Shares of a node or a session (doc/access-control.md#归属与分享): the same table and form, with the access
 * levels of the resource.
 */
export function Shares({
	target,
	id,
	shares,
	onChange,
}: {
	target: ShareTarget;
	id: string;
	shares: (NodeShare | SessionShare)[];
	onChange: () => void;
}) {
	const levels: Access[] = target === "node" ? ["view", "operate"] : ["view", "chat"];
	const [type, setType] = useState<GranteeType>("user");
	const [grantee, setGrantee] = useState("");
	const [access, setAccess] = useState<Access>("view");
	const { busy, error, run } = useAction();
	const dir = useDirectory();
	const options =
		type === "user"
			? dir.users.map((u) => ({ id: u.id, label: u.displayName || u.username }))
			: dir.userGroups.map((g) => ({ id: g.id, label: g.name }));
	const add = async (e: FormEvent) => {
		e.preventDefault();
		const done =
			target === "node"
				? await run(() => api.shareNode(id, type, grantee.trim(), access as "view" | "operate"))
				: await run(() => api.shareSession(id, type, grantee.trim(), access as "view" | "chat"));
		if (done) {
			setGrantee("");
			onChange();
		}
	};
	const remove = async (shareId: string) => {
		const done =
			target === "node"
				? await run(() => api.unshareNode(id, shareId))
				: await run(() => api.unshareSession(id, shareId));
		if (done) onChange();
	};
	const rows = shares as ShareRow[];
	return (
		<section aria-label="Shares">
			<h2>Shares</h2>
			{rows.length > 0 ? (
				<table>
					<thead>
						<tr>
							<th>Grantee</th>
							<th>Access</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{rows.map((s) => (
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
							setGrantee("");
						}}
					>
						<option value="user">user</option>
						<option value="user_group">user group</option>
					</select>
				</label>
				<label>
					Grantee
					<select value={grantee} onChange={(e) => setGrantee(e.target.value)} required>
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
					<select value={access} onChange={(e) => setAccess(e.target.value as Access)}>
						{levels.map((l) => (
							<option key={l} value={l}>
								{l}
							</option>
						))}
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
