import { startRegistration } from "@simplewebauthn/browser";
import { type FormEvent, useState } from "react";
import { api, type CredentialView } from "../api.ts";
import { CopyButton, ErrorText, Loading } from "../components/Feedback.tsx";
import { errMsg, useLoad } from "../hooks.ts";
import { credentialTrustSnippet, formatTime } from "../lib.ts";

function keyId(credential: CredentialView): string {
	return credential.kind === "ssh" ? (credential.fingerprint ?? "") : (credential.credentialId ?? "");
}

/**
 * Signing credentials (doc/m4.md M4.4): the SSH keys and Passkeys that let this user authorize
 * privileged tasks on a node. Each row exports the `[[trust]]` block to paste into that node's
 * privileged.toml.
 */
export function Credentials() {
	const { data, error, loading, reload } = useLoad(() => api.listCredentials(), []);
	const [line, setLine] = useState("");
	const [sshName, setSshName] = useState("");
	const [passkeyName, setPasskeyName] = useState("");
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string>();
	const [snippetId, setSnippetId] = useState<string>();
	const credentials = data ?? [];

	const addSsh = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setActionError(undefined);
		try {
			await api.addSshCredential(line.trim(), sshName.trim() || undefined);
			setLine("");
			setSshName("");
			reload();
		} catch (err) {
			setActionError(errMsg(err));
		} finally {
			setBusy(false);
		}
	};

	const addPasskey = async () => {
		setBusy(true);
		setActionError(undefined);
		try {
			const { options } = await api.passkeyOptions();
			const response = await startRegistration({ optionsJSON: options as never });
			await api.registerPasskey(response, passkeyName.trim() || undefined);
			setPasskeyName("");
			reload();
		} catch (err) {
			const cancelled = err instanceof DOMException && err.name === "NotAllowedError";
			setActionError(cancelled ? "Passkey registration was cancelled." : errMsg(err));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (credential: CredentialView) => {
		if (!confirm(`Delete the credential "${credential.name}"?`)) return;
		setBusy(true);
		setActionError(undefined);
		try {
			await api.deleteCredential(credential.id);
			reload();
		} catch (err) {
			setActionError(errMsg(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<h1>Signing credentials</h1>
			<p className="muted">
				A node authorizes a privileged task signed by one of these credentials when its privileged.toml trusts the key.{" "}
				<a href="#/authorizations">Authorizations</a> lists what you signed and lets you revoke it.
			</p>
			<Loading loading={loading && !data} error={error} />
			<ErrorText error={actionError} />

			<section>
				<h2>Add an SSH key</h2>
				<form onSubmit={addSsh} className="stack">
					<label>
						Name (optional)
						<input value={sshName} onChange={(e) => setSshName(e.target.value)} maxLength={100} />
					</label>
					<label>
						Public key
						<textarea
							value={line}
							onChange={(e) => setLine(e.target.value)}
							rows={3}
							placeholder="ssh-ed25519 AAAAC3Nza… you@laptop"
							required
						/>
					</label>
					<p className="muted">
						Paste one authorized_keys line. Supported: ssh-ed25519, sk-ssh-ed25519@openssh.com, ecdsa-sha2-nistp256 and
						sk-ecdsa-sha2-nistp256@openssh.com.
					</p>
					<div className="row">
						<button type="submit" className="primary" disabled={busy || line.trim() === ""}>
							Add SSH key
						</button>
					</div>
				</form>
			</section>

			<section>
				<h2>Add a Passkey</h2>
				<label>
					Name (optional)
					<input value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} maxLength={100} />
				</label>
				<div className="row">
					<button type="button" className="primary" onClick={addPasskey} disabled={busy}>
						Register Passkey
					</button>
				</div>
				<p className="muted">
					The browser offers a platform authenticator (Touch ID, Windows Hello) or a security key. Only ES256, EdDSA and
					RS256 are requested, so a registered Passkey is one the node's privileged mode can verify.
				</p>
			</section>

			<section>
				<div className="row">
					<h2>Your credentials</h2>
					<span className="spacer" />
					<button type="button" onClick={reload}>
						Refresh
					</button>
				</div>
				{credentials.length === 0 ? (
					<p className="muted">No credentials yet.</p>
				) : (
					<div className="scroll-x">
						<table>
							<thead>
								<tr>
									<th>Name</th>
									<th>Kind</th>
									<th>Key</th>
									<th>Added</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{credentials.map((credential) => (
									<tr key={credential.id}>
										<td>{credential.name}</td>
										<td>{credential.kind === "ssh" ? "SSH key" : "Passkey"}</td>
										<td className="mono">{keyId(credential)}</td>
										<td>{formatTime(credential.createdAt)}</td>
										<td className="actions">
											<button
												type="button"
												onClick={() => setSnippetId(snippetId === credential.id ? undefined : credential.id)}
											>
												{snippetId === credential.id ? "Hide snippet" : "Trust snippet"}
											</button>
											<button type="button" className="danger" onClick={() => remove(credential)} disabled={busy}>
												Delete
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{credentials
					.filter((credential) => credential.id === snippetId)
					.map((credential) => (
						<div key={credential.id}>
							<div className="row">
								<h3>{credential.name}: privileged.toml</h3>
								<span className="spacer" />
								<CopyButton text={credentialTrustSnippet(credential)} label="Copy snippet" />
							</div>
							<pre className="output">{credentialTrustSnippet(credential)}</pre>
						</div>
					))}
			</section>
		</>
	);
}
