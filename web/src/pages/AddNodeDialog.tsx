import { useState } from "react";
import { api } from "../api.ts";
import { CopyButton, ErrorText } from "../components/Feedback.tsx";
import { Modal } from "../components/Modal.tsx";
import { useAction } from "../hooks.ts";
import { enrollCommand, formatTime } from "../lib.ts";

export function AddNodeDialog({ onClose }: { onClose: () => void }) {
	const [hint, setHint] = useState("");
	const [created, setCreated] = useState<{ token: string; expiresAt: string }>();
	const { busy, error, run } = useAction();
	const create = async () => {
		const r = await run(() => api.createEnrollmentToken(hint.trim() || undefined));
		if (r) setCreated(r);
	};
	const command = created ? enrollCommand(window.location.origin, created.token) : "";
	return (
		<Modal title="Add node" onClose={onClose}>
			<div className="stack">
				{created ? (
					<>
						<p>Run this on the node:</p>
						<pre className="output">{command}</pre>
						<p className="muted">The token is shown once and expires {formatTime(created.expiresAt)}.</p>
						<p className="muted">
							After the node connects it appears as pending; compare its key fingerprint with <code>crha status</code>{" "}
							on the node before approving.
						</p>
					</>
				) : (
					<label>
						Name hint (optional)
						<input value={hint} onChange={(e) => setHint(e.target.value)} />
					</label>
				)}
				<ErrorText error={error} />
				<div className="row end">
					{created ? (
						<CopyButton text={command} label="Copy command" />
					) : (
						<button type="button" className="primary" onClick={create} disabled={busy}>
							Create token
						</button>
					)}
					<button type="button" onClick={onClose}>
						Close
					</button>
				</div>
			</div>
		</Modal>
	);
}
