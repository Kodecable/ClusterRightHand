import { type FormEvent, useState } from "react";
import { api, type User, type UserGroup } from "../api.ts";
import { ErrorText, Loading } from "../components/Feedback.tsx";
import { useAction, useLoad } from "../hooks.ts";

function GroupCard({ g, users, onChange }: { g: UserGroup; users: User[]; onChange: () => void }) {
	const [pick, setPick] = useState("");
	const { busy, error, run } = useAction();
	const names = new Map(users.map((u) => [u.id, u.username]));
	const candidates = users.filter((u) => !g.memberIds.includes(u.id));
	const act = async (fn: () => Promise<unknown>) => {
		if (await run(fn)) onChange();
	};
	return (
		<div className="card stack">
			<div className="row">
				<h3>{g.name}</h3>
				<span className="spacer" />
				<span className="muted mono">{g.id}</span>
				<button
					type="button"
					className="danger"
					disabled={busy}
					onClick={() =>
						window.confirm(`Delete group ${g.name}? Shares to it are removed.`) && act(() => api.deleteGroup(g.id))
					}
				>
					Delete
				</button>
			</div>
			<ul className="chips">
				{g.memberIds.map((id) => (
					<li key={id}>
						{names.get(id) ?? id}{" "}
						<button
							type="button"
							aria-label={`Remove ${names.get(id) ?? id}`}
							disabled={busy}
							onClick={() => act(() => api.removeMember(g.id, id))}
						>
							×
						</button>
					</li>
				))}
				{g.memberIds.length === 0 && <li className="muted">no members</li>}
			</ul>
			<div className="row">
				<select aria-label={`Add member to ${g.name}`} value={pick} onChange={(e) => setPick(e.target.value)}>
					<option value="">Add member…</option>
					{candidates.map((u) => (
						<option key={u.id} value={u.id}>
							{u.username}
						</option>
					))}
				</select>
				<button
					type="button"
					disabled={busy || !pick}
					onClick={() => act(() => api.addMember(g.id, pick).then(() => setPick("")))}
				>
					Add
				</button>
			</div>
			<ErrorText error={error} />
		</div>
	);
}

export function UserGroups({ users }: { users: User[] }) {
	const groups = useLoad(() => api.listGroups(), []);
	const [name, setName] = useState("");
	const { busy, error, run } = useAction();
	const create = async (e: FormEvent) => {
		e.preventDefault();
		if (await run(() => api.createGroup(name))) {
			setName("");
			groups.reload();
		}
	};
	return (
		<section>
			<h2>User groups</h2>
			<form onSubmit={create} className="row wrap">
				<label>
					Group name
					<input value={name} onChange={(e) => setName(e.target.value)} required />
				</label>
				<button type="submit" disabled={busy}>
					Create group
				</button>
			</form>
			<ErrorText error={error} />
			<Loading loading={groups.loading && !groups.data} error={groups.error} />
			<div className="grid">
				{groups.data?.map((g) => (
					<GroupCard key={g.id} g={g} users={users} onChange={groups.reload} />
				))}
			</div>
		</section>
	);
}
