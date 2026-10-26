import { useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler, type User } from "./api.ts";
import { UserProvider } from "./auth.tsx";
import { Header } from "./components/Header.tsx";
import { appTitle } from "./meta.ts";
import { Login } from "./pages/Login.tsx";
import { NodeDetail } from "./pages/NodeDetail.tsx";
import { Nodes } from "./pages/Nodes.tsx";
import { TaskPage } from "./pages/TaskPage.tsx";
import { Users } from "./pages/Users.tsx";
import { navigate, useRoute } from "./router.ts";

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
		navigate("/nodes");
	}, []);

	if (auth.state === "loading") return <p className="muted pad">Loading…</p>;
	if (auth.state === "out") return <Login onLogin={onLogin} />;

	const [, id] = route;
	let page = <Nodes />;
	if (section === "nodes" && id) page = <NodeDetail key={id} id={id} />;
	else if (section === "tasks" && id) page = <TaskPage key={id} id={id} />;
	else if (section === "users")
		page = auth.user.kind === "admin" ? <Users /> : <p className="error">Administrators only.</p>;

	return (
		<UserProvider user={auth.user}>
			<Header route={route} onLogout={() => setAuth({ state: "out" })} />
			<main>{page}</main>
		</UserProvider>
	);
}
