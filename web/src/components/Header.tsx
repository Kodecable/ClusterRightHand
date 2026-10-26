import { useState } from "react";
import { api } from "../api.ts";
import { useUser } from "../auth.tsx";
import { APP_NAME } from "../meta.ts";
import { ChangePassword } from "./ChangePassword.tsx";

export function Header({ route, onLogout }: { route: string[]; onLogout: () => void }) {
	const user = useUser();
	const [changing, setChanging] = useState(false);
	const logout = async () => {
		try {
			await api.logout();
		} finally {
			onLogout();
		}
	};
	return (
		<header className="top">
			<a className="brand" href="#/nodes">
				{APP_NAME}
			</a>
			<nav>
				<a href="#/nodes" aria-current={route[0] === "nodes" || !route[0] ? "page" : undefined}>
					Nodes
				</a>
				<a href="#/batch" aria-current={route[0] === "batch" ? "page" : undefined}>
					Batch
				</a>
				{user.kind === "admin" && (
					<a href="#/users" aria-current={route[0] === "users" ? "page" : undefined}>
						Users
					</a>
				)}
			</nav>
			<span className="spacer" />
			<span className="who">
				{user.displayName || user.username} <span className="muted">({user.kind})</span>
			</span>
			<button type="button" onClick={() => setChanging(true)}>
				Change password
			</button>
			<button type="button" onClick={logout}>
				Log out
			</button>
			{changing && <ChangePassword onClose={() => setChanging(false)} />}
		</header>
	);
}
