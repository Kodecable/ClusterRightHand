import { type FormEvent, useState } from "react";
import { api, type User, type UserKind } from "../api.ts";
import { useUser } from "../auth.tsx";
import { Badge, ErrorText, Loading } from "../components/Feedback.tsx";
import { useAction, useLoad } from "../hooks.ts";
import { formatTime } from "../lib.ts";
import { UserGroups } from "./UserGroups.tsx";

function CreateUser({ onCreated }: { onCreated: () => void }) {
	const [username, setUsername] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [kind, setKind] = useState<UserKind>("member");
	const [password, setPassword] = useState("");
	const { busy, error, run } = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const u = await run(() =>
			api.createUser({ username, displayName: displayName || undefined, kind, password: password || undefined }),
		);
		if (u) {
			setUsername("");
			setDisplayName("");
			setPassword("");
			onCreated();
		}
	};
	return (
		<form onSubmit={submit} className="row wrap">
			<label>
				Username
				<input value={username} onChange={(e) => setUsername(e.target.value)} required />
			</label>
			<label>
				Display name
				<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
			</label>
			<label>
				Kind
				<select value={kind} onChange={(e) => setKind(e.target.value as UserKind)}>
					<option value="member">member</option>
					<option value="admin">admin</option>
				</select>
			</label>
			<label>
				Password
				<input
					type="password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					autoComplete="new-password"
				/>
			</label>
			<button type="submit" className="primary" disabled={busy}>
				Create user
			</button>
			<ErrorText error={error} />
		</form>
	);
}

function UserRow({ u, self, onChange }: { u: User; self: boolean; onChange: () => void }) {
	const { busy, error, run } = useAction();
	const patch = async (p: Parameters<typeof api.updateUser>[1]) => {
		if (await run(() => api.updateUser(u.id, p))) onChange();
	};
	const reset = async () => {
		const pw = window.prompt(`New password for ${u.username} (min 8 characters)`);
		if (pw) await run(() => api.setPassword(u.id, pw));
	};
	return (
		<tr>
			<td>{u.username}</td>
			<td>{u.displayName}</td>
			<td>
				<select
					aria-label={`Kind of ${u.username}`}
					value={u.kind}
					disabled={busy}
					onChange={(e) => patch({ kind: e.target.value as UserKind })}
				>
					<option value="member">member</option>
					<option value="admin">admin</option>
				</select>
			</td>
			<td>
				<Badge kind={u.status === "active" ? "active" : "disabled"}>{u.status}</Badge>
			</td>
			<td>{formatTime(u.createdAt)}</td>
			<td className="actions">
				<button
					type="button"
					disabled={busy || self}
					title={self ? "You cannot disable yourself" : undefined}
					onClick={() => patch({ status: u.status === "active" ? "disabled" : "active" })}
				>
					{u.status === "active" ? "Disable" : "Enable"}
				</button>
				<button type="button" disabled={busy} onClick={reset}>
					Reset password
				</button>
				<ErrorText error={error} />
			</td>
		</tr>
	);
}

export function Users() {
	const me = useUser();
	const users = useLoad(() => api.listUsers(), []);
	return (
		<>
			<h1>Users</h1>
			<CreateUser onCreated={users.reload} />
			<Loading loading={users.loading && !users.data} error={users.error} />
			{users.data && (
				<div className="scroll-x">
					<table>
						<thead>
							<tr>
								<th>Username</th>
								<th>Display name</th>
								<th>Kind</th>
								<th>Status</th>
								<th>Created</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{users.data.map((u) => (
								<UserRow key={u.id} u={u} self={u.id === me.id} onChange={users.reload} />
							))}
						</tbody>
					</table>
				</div>
			)}
			{users.data && <UserGroups users={users.data} />}
		</>
	);
}
