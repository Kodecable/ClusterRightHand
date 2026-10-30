import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";
import { api, type GroupPendingTask, type PendingAuthorization, type PendingPasskey } from "../api.ts";
import { authorizationLines, grantCommand, sshKeygenRecipe } from "../authorization.ts";
import { useLoad, usePolling } from "../hooks.ts";
import { CopyButton, ErrorText, Loading } from "./Feedback.tsx";

function Rejection({ rejection }: { rejection: PendingAuthorization["lastRejection"] }) {
	if (!rejection) return null;
	return (
		<p className="error">
			Last rejection {rejection.code} (attempt {rejection.attempt}): {rejection.message}
		</p>
	);
}

function GroupTaskTable({ tasks }: { tasks: GroupPendingTask[] }) {
	return (
		<div className="scroll-x">
			<table>
				<thead>
					<tr>
						<th>Node</th>
						<th>Task</th>
						<th>Attempt</th>
						<th>State</th>
						<th>Last rejection</th>
					</tr>
				</thead>
				<tbody>
					{tasks.map((task) => (
						<tr key={task.id}>
							<td>{task.nodeName}</td>
							<td className="mono">
								<a href={`#/tasks/${task.id}`}>{task.id.slice(0, 8)}…</a>
							</td>
							<td>{task.attempt}</td>
							<td>{task.state}</td>
							<td>{task.lastRejection ? `${task.lastRejection.code}: ${task.lastRejection.message}` : "-"}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/**
 * The waiting page of a task or task group whose owner has to sign the payload (doc/m4.md M4.4):
 * the decoded payload, a Passkey button for every matching credential, the `crha grant` command and
 * the `ssh-keygen` recipe, a paste box for the result, and the local-approval alternative.
 */
export function AuthorizationWait({
	kind,
	id,
	onChanged,
}: {
	kind: "task" | "group";
	id: string;
	onChanged?: () => void;
}) {
	const load = useLoad<{ pending: PendingAuthorization | null; tasks: GroupPendingTask[] }>(async () => {
		if (kind === "task") return { pending: await api.getTaskAuthorization(id), tasks: [] };
		const group = await api.getTaskGroupAuthorization(id);
		return { pending: group?.authorization ?? null, tasks: group?.tasks ?? [] };
	}, [kind, id]);
	usePolling(load.reload, 5_000);
	const [pasted, setPasted] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [done, setDone] = useState<string>();

	const pending = load.data?.pending ?? null;
	const tasks = load.data?.tasks ?? [];

	const submitted = (dispatched: string[]) => {
		setDone(
			dispatched.length === 0
				? "Signed and stored. No waiting task could be dispatched with it yet; the waiting page updates when it can be used."
				: `Signed. Dispatched ${dispatched.length} task${dispatched.length === 1 ? "" : "s"}.`,
		);
		load.reload();
		onChanged?.();
	};

	const signPasskey = async (passkey: PendingPasskey) => {
		if (!pending) return;
		setBusy(true);
		setError(undefined);
		try {
			const response = await startAuthentication({
				optionsJSON: {
					rpId: passkey.rpId,
					challenge: pending.challenge,
					allowCredentials: [{ id: passkey.credentialId, type: "public-key" }],
					userVerification: passkey.requireUv ? "required" : "preferred",
					timeout: 60_000,
				},
			});
			const result = await api.submitAuthorization({ payloadId: pending.id, webauthn: response });
			submitted(result.dispatched);
		} catch (err) {
			// DOMException NotAllowedError: the user dismissed the Passkey prompt.
			const cancelled = err instanceof DOMException && err.name === "NotAllowedError";
			setError(cancelled ? "Passkey signing was cancelled." : err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const submitPaste = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const result = await api.submitAuthorization({ authorization: pasted.trim() });
			setPasted("");
			submitted(result.dispatched);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (load.loading && load.data === undefined) return <Loading loading error={load.error} />;
	if (load.error) return <ErrorText error={load.error} />;
	if (!pending) return <p className="muted">The pending payload is being prepared…</p>;

	return (
		<section className="waiting">
			<h2>Waiting for your authorization</h2>
			<p className="muted">
				Sign the payload below with `crha grant` (or your Passkey) in the WebUI. The signature is bound to this attempt:
				if the plan changes, the page shows a new payload.
			</p>
			{kind === "group" && tasks.length > 0 && <GroupTaskTable tasks={tasks} />}
			<dl className="kv">
				{authorizationLines(pending).map((line) => (
					<div key={line.label} className="kv-row">
						<dt>{line.label}</dt>
						<dd className={line.mono ? "mono" : undefined}>{line.value}</dd>
					</div>
				))}
			</dl>
			{pending.tried.length > 0 && <p className="muted">Already tried: {pending.tried.join(", ")}.</p>}
			<Rejection rejection={pending.lastRejection} />

			{pending.passkeys.length > 0 && (
				<div className="row wrap">
					{pending.passkeys.map((passkey) => (
						<button
							key={`${passkey.credentialId}@${passkey.rpId}`}
							type="button"
							className="primary"
							disabled={busy}
							onClick={() => signPasskey(passkey)}
						>
							Sign with Passkey "{passkey.name}"
						</button>
					))}
				</div>
			)}
			{pending.passkeys.length === 0 && (
				<p className="muted">
					No Passkey of yours is trusted by this node for this command; sign with your SSH key below.
				</p>
			)}

			<h3>Sign on your workstation</h3>
			<div className="row">
				<span className="spacer" />
				<CopyButton text={grantCommand(pending.payload)} label="Copy crha grant command" />
			</div>
			<pre className="output">{grantCommand(pending.payload)}</pre>
			<p className="muted">
				`crha grant` decodes the payload for confirmation, signs it with `ssh-keygen -Y sign -n crh-auth-v1` and prints
				the authorization to paste below. The same thing by hand:
			</p>
			<div className="row">
				<span className="spacer" />
				<CopyButton text={sshKeygenRecipe(pending.payload)} label="Copy ssh-keygen recipe" />
			</div>
			<pre className="output">{sshKeygenRecipe(pending.payload)}</pre>

			<label>
				Authorization from `crha grant`
				<textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} />
			</label>
			<div className="row">
				<button type="button" className="primary" disabled={busy || pasted.trim() === ""} onClick={submitPaste}>
					Submit authorization
				</button>
			</div>
			{kind === "task" && pending.localRequested && (
				<p className="muted">
					Or run <code>crha approve {id}</code> on the node (a user in its `local` trust entries) — the task then runs
					with that approval instead.
				</p>
			)}
			<ErrorText error={error} />
			{done && <p className="ok">{done}</p>}
		</section>
	);
}
