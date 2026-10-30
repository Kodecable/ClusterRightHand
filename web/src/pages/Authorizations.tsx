import { useState } from "react";
import { type AuthorizationSummary, api, type DecodedAuthorizationPayload } from "../api.ts";
import { useUser } from "../auth.tsx";
import { Badge, ErrorText, Loading } from "../components/Feedback.tsx";
import { useLoad } from "../hooks.ts";
import { formatTime } from "../lib.ts";

function commandText(command: DecodedAuthorizationPayload["command"]): string {
	if (command === null) return "any method and target";
	if (command.match === "exact") return `${command.method} exact ${command.target}`;
	return `${command.method} prefix ${command.target}`;
}

/**
 * Authorizations (doc/m4.md M4.4, doc/privilege.md#吊销): what this user signed — administrators see
 * their organization's — and where to revoke it. A revocation is pushed to the nodes with
 * `revocations.add`; a node that is offline gets it after its next `ok` trust report.
 */
export function Authorizations() {
	const user = useUser();
	const { data, error, loading, reload } = useLoad(() => api.listAuthorizations(), []);
	const [actionError, setActionError] = useState<string>();
	const [busy, setBusy] = useState<string>();
	const authorizations = data ?? [];

	const revoke = async (entry: AuthorizationSummary) => {
		if (!confirm(`Revoke authorization ${entry.id.slice(0, 12)}…? Nodes that trust it drop its permissions.`)) return;
		setBusy(entry.id);
		setActionError(undefined);
		try {
			await api.revokeAuthorization(entry.id);
			reload();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(undefined);
		}
	};

	return (
		<>
			<div className="row">
				<h1>Authorizations</h1>
				<span className="spacer" />
				<button type="button" onClick={reload}>
					Refresh
				</button>
			</div>
			<p className="muted">
				An authorization is valid on the nodes its payload names until its deadline, until it is used up (one-shot
				authorizations) or until it is revoked here. Revocations reach a node that is offline after its next connection.
			</p>
			<Loading loading={loading && !data} error={error} />
			<ErrorText error={actionError} />
			{data && authorizations.length === 0 && <p className="muted">You have not signed any authorization yet.</p>}
			{authorizations.length > 0 && (
				<div className="scroll-x">
					<table>
						<thead>
							<tr>
								<th>Created</th>
								<th>Issuer</th>
								<th>Nodes</th>
								<th>Command</th>
								<th>Deadline</th>
								<th>Tasks</th>
								<th>Status</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{authorizations.map((entry) => (
								<tr key={entry.id}>
									<td>{formatTime(entry.createdAt)}</td>
									<td>{entry.issuerUsername ?? (entry.issuerUserId ? entry.issuerUserId.slice(0, 8) : "crhs")}</td>
									<td className="mono">{entry.nodes.join(", ") || "-"}</td>
									<td className="mono">{commandText(entry.command)}</td>
									<td>{formatTime(entry.deadline)}</td>
									<td className="mono">
										{entry.taskIds === null
											? "reusable"
											: `${entry.taskIds.length} task${entry.taskIds.length === 1 ? "" : "s"}`}
									</td>
									<td>{entry.revokedAt ? <Badge kind="bad">revoked</Badge> : <Badge kind="ok">active</Badge>}</td>
									<td className="actions">
										<details>
											<summary>Payload</summary>
											<dl className="kv">
												<dt>Id</dt>
												<dd className="mono">{entry.id}</dd>
												<dt>Issued</dt>
												<dd>{formatTime(entry.issuedAt)}</dd>
												{entry.attempt !== null && (
													<>
														<dt>Attempt</dt>
														<dd>{entry.attempt}</dd>
													</>
												)}
												{entry.note && (
													<>
														<dt>Note</dt>
														<dd>{entry.note}</dd>
													</>
												)}
												<dt>Revoked</dt>
												<dd>{formatTime(entry.revokedAt)}</dd>
											</dl>
										</details>
										{entry.revokedAt === null && (user.kind === "admin" || entry.issuerUserId === user.id) && (
											<button
												type="button"
												className="danger"
												disabled={busy === entry.id}
												onClick={() => revoke(entry)}
											>
												Revoke
											</button>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</>
	);
}
