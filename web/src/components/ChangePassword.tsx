import { type FormEvent, useState } from "react";
import { api } from "../api.ts";
import { useAction } from "../hooks.ts";
import { ErrorText } from "./Feedback.tsx";
import { Modal } from "./Modal.tsx";

export function ChangePassword({ onClose }: { onClose: () => void }) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [again, setAgain] = useState("");
	const [done, setDone] = useState(false);
	const { busy, error, run, setError } = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (next !== again) return setError("the new passwords do not match");
		if (await run(() => api.changePassword(current, next))) setDone(true);
	};
	return (
		<Modal title="Change password" onClose={onClose}>
			{done ? (
				<div className="stack">
					<p>Password changed.</p>
					<div className="row end">
						<button type="button" onClick={onClose}>
							Close
						</button>
					</div>
				</div>
			) : (
				<form onSubmit={submit} className="stack">
					<label>
						Current password
						<input
							type="password"
							autoComplete="current-password"
							value={current}
							onChange={(e) => setCurrent(e.target.value)}
							required
						/>
					</label>
					<label>
						New password
						<input
							type="password"
							autoComplete="new-password"
							value={next}
							onChange={(e) => setNext(e.target.value)}
							required
						/>
					</label>
					<label>
						Repeat new password
						<input
							type="password"
							autoComplete="new-password"
							value={again}
							onChange={(e) => setAgain(e.target.value)}
							required
						/>
					</label>
					<ErrorText error={error} />
					<div className="row end">
						<button type="submit" className="primary" disabled={busy}>
							Change
						</button>
						<button type="button" onClick={onClose}>
							Cancel
						</button>
					</div>
				</form>
			)}
		</Modal>
	);
}
