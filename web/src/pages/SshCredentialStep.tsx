import { useState } from "react";
import { api } from "../api.ts";
import { CopyButton, ErrorText, Loading } from "../components/Feedback.tsx";
import { useAction, useLoad } from "../hooks.ts";

/** Wizard step 1: choose or create the SSH credential whose public key goes into authorized_keys. */
export function SshCredentialStep({ value, onChange }: { value: string; onChange: (id: string) => void }) {
	const creds = useLoad(() => api.listSshCredentials(), []);
	const [name, setName] = useState("");
	const { busy, error, run } = useAction();
	const create = async () => {
		const c = await run(() => api.createSshCredential(name.trim()));
		if (c) {
			setName("");
			creds.reload();
			onChange(c.id);
		}
	};
	const current = creds.data?.find((c) => c.id === value);
	return (
		<div className="stack">
			<Loading loading={creds.loading && !creds.data} error={creds.error} />
			{creds.data && creds.data.length > 0 && (
				<label>
					SSH credential
					<select value={value} onChange={(e) => onChange(e.target.value)}>
						<option value="">Select…</option>
						{creds.data.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
							</option>
						))}
					</select>
				</label>
			)}
			<div className="row wrap">
				<label>
					New credential name
					<input value={name} onChange={(e) => setName(e.target.value)} />
				</label>
				<button type="button" onClick={create} disabled={busy || !name.trim()}>
					Create credential
				</button>
			</div>
			<ErrorText error={error} />
			{current && (
				<>
					<pre className="output">{current.publicKey}</pre>
					<div className="row">
						<CopyButton text={current.publicKey} label="Copy public key" />
					</div>
					<p className="muted">
						Append this key to <code>~/.ssh/authorized_keys</code> of the target user on every hop (each jump host and
						the target), before continuing.
					</p>
				</>
			)}
		</div>
	);
}
