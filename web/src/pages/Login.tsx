import { type FormEvent, useState } from "react";
import { api, type User } from "../api.ts";
import { ErrorText } from "../components/Feedback.tsx";
import { useAction } from "../hooks.ts";
import { APP_NAME } from "../meta.ts";

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const { busy, error, run } = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const user = await run(() => api.login(username, password));
		if (user) onLogin(user);
	};
	return (
		<main className="login">
			<form onSubmit={submit} className="card stack">
				<h1>{APP_NAME}</h1>
				<label>
					Username
					<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
				</label>
				<label>
					Password
					<input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="current-password"
						required
					/>
				</label>
				<ErrorText error={error} />
				<button type="submit" className="primary" disabled={busy}>
					Sign in
				</button>
			</form>
		</main>
	);
}
