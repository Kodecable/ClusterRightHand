import { useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler, type User } from "./api.ts";
import { UserProvider } from "./auth.tsx";
import { Header } from "./components/Header.tsx";
import { appTitle } from "./meta.ts";
import { ApprovalDetail, Approvals } from "./pages/Approvals.tsx";
import { Audit } from "./pages/Audit.tsx";
import { Authorizations } from "./pages/Authorizations.tsx";
import { Batch } from "./pages/Batch.tsx";
import { Credentials } from "./pages/Credentials.tsx";
import { Login } from "./pages/Login.tsx";
import { ModelSettings } from "./pages/ModelSettings.tsx";
import { NodeDetail } from "./pages/NodeDetail.tsx";
import { Nodes } from "./pages/Nodes.tsx";
import { SessionPage } from "./pages/SessionPage.tsx";
import { Sessions } from "./pages/Sessions.tsx";
import { TaskPage } from "./pages/TaskPage.tsx";
import { Tokens } from "./pages/Tokens.tsx";
import { Users } from "./pages/Users.tsx";
import { navigate, parseHash, useRoute } from "./router.ts";

type Auth = { state: "loading" } | { state: "out" } | { state: "in"; user: User };

export function App() {
	const [auth, setAuth] = useState<Auth>({ state: "loading" });
	const route = useRoute();

	useEffect(() => {
		setUnauthorizedHandler(() => setAuth({ state: "out" }));
		api.me().then(
			(user) => setAuth({ state: "in", user }),
			() => setAuth({ state: "out" }),
		);
	}, []);

	const section = route[0] ?? "nodes";
	useEffect(() => {
		document.title = appTitle(auth.state === "in" ? section : "Sign in");
	}, [auth.state, section]);

	const onLogin = useCallback((user: User) => {
		setAuth({ state: "in", user });
		// Keep a deep link (e.g. an approval URL handed out over MCP) that led to the sign-in form.
		if (parseHash(location.hash).length === 0) navigate("/nodes");
	}, []);

	if (auth.state === "loading") return <p className="muted pad">Loading…</p>;
	if (auth.state === "out") return <Login onLogin={onLogin} />;

	const [, id] = route;
	let page = <Nodes />;
	if (section === "nodes" && id) page = <NodeDetail key={id} id={id} />;
	else if (section === "sessions" && id) page = <SessionPage key={id} id={id} />;
	else if (section === "sessions") page = <Sessions />;
	else if (section === "settings" && id === "models")
		page = auth.user.kind === "admin" ? <ModelSettings /> : <p className="error">Administrators only.</p>;
	else if (section === "tasks" && id) page = <TaskPage key={id} id={id} />;
	else if (section === "batch") page = <Batch />;
	else if (section === "credentials") page = <Credentials />;
	else if (section === "authorizations") page = <Authorizations />;
	else if (section === "tokens") page = <Tokens />;
	else if (section === "approvals" && (id === "tasks" || id === "task-groups") && route[2])
		page = <ApprovalDetail key={`${id}/${route[2]}`} kind={id} id={route[2]} />;
	else if (section === "approvals") page = <Approvals />;
	else if (section === "audit") page = <Audit />;
	else if (section === "users")
		page = auth.user.kind === "admin" ? <Users /> : <p className="error">Administrators only.</p>;

	return (
		<UserProvider user={auth.user}>
			<Header route={route} onLogout={() => setAuth({ state: "out" })} />
			<main>{page}</main>
		</UserProvider>
	);
}
