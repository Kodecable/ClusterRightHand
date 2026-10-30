import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useUser } from "../auth.tsx";
import { useLoad, usePolling } from "../hooks.ts";
import { pendingCount } from "../lib.ts";
import { APP_NAME } from "../meta.ts";
import { ChangePassword } from "./ChangePassword.tsx";

const APPROVALS_CHANGED = "crh:approvals-changed";

/**
 * Number of requests waiting for the user: approvals it handles, plus the tasks and groups that wait
 * for its signature (doc/privilege.md). Refreshed every 10 s and after decisions.
 */
function usePendingCount(path: string): number {
	const { data, reload } = useLoad(() => api.listApprovals(), []);
	usePolling(reload, 10_000);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh when the page changes
	useEffect(reload, [path, reload]);
	useEffect(() => {
		window.addEventListener(APPROVALS_CHANGED, reload);
		return () => window.removeEventListener(APPROVALS_CHANGED, reload);
	}, [reload]);
	return pendingCount(data);
}

export function Header({ route, onLogout }: { route: string[]; onLogout: () => void }) {
	const user = useUser();
	const pending = usePendingCount(route.join("/"));
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
				<a href="#/sessions" aria-current={route[0] === "sessions" ? "page" : undefined}>
					Sessions
				</a>
				<a href="#/nodes" aria-current={route[0] === "nodes" || !route[0] ? "page" : undefined}>
					Nodes
				</a>
				<a href="#/tasks" aria-current={route[0] === "tasks" || route[0] === "task-groups" ? "page" : undefined}>
					Tasks
				</a>
				<a href="#/batch" aria-current={route[0] === "batch" ? "page" : undefined}>
					Batch
				</a>
				<a href="#/approvals" aria-current={route[0] === "approvals" ? "page" : undefined}>
					Approvals
					{pending > 0 && (
						<span className="count" role="status" aria-label={`${pending} pending`}>
							{pending}
						</span>
					)}
				</a>
				<a href="#/credentials" aria-current={route[0] === "credentials" ? "page" : undefined}>
					Credentials
				</a>
				<a href="#/authorizations" aria-current={route[0] === "authorizations" ? "page" : undefined}>
					Authorizations
				</a>
				<a href="#/tokens" aria-current={route[0] === "tokens" ? "page" : undefined}>
					API tokens
				</a>
				<a href="#/audit" aria-current={route[0] === "audit" ? "page" : undefined}>
					Audit
				</a>
				{user.kind === "admin" && (
					<a href="#/settings/models" aria-current={route[0] === "settings" ? "page" : undefined}>
						Models
					</a>
				)}
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
