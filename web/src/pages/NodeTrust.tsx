import { api, type GuardRule, type TrustEntry, type TrustEntryKey } from "../api.ts";
import { Loading } from "../components/Feedback.tsx";
import { useLoad } from "../hooks.ts";
import { formatTime } from "../lib.ts";

/** How a trust entry's key is identified on the node. */
function keyText(key: TrustEntryKey): string {
	switch (key.kind) {
		case "sshsig":
			return key.fingerprint ?? key.publicKey ?? "";
		case "webauthn":
			return key.rpId ?? "";
		case "local":
			return (key.uids ?? []).join(", ");
	}
}

function ttlText(ms: number | null): string {
	if (ms === null) return "unlimited";
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return `${ms}ms`;
}

function guardRuleText(rule: GuardRule): string {
	const target = rule.match === "any" ? "any target" : `${rule.match} ${rule.pattern}`;
	return `${rule.method} ${target}`;
}

function flags(entry: TrustEntry): string {
	return (
		[entry.requireExact && "require_exact", entry.requireTask && "require_task", entry.requireUv && "require_uv"]
			.filter(Boolean)
			.join(", ") || "-"
	);
}

/**
 * Who a node trusts (doc/privilege.md#信任缓存): the last TrustReport it pushed, its digest and every
 * trust entry with the flags, the rules and the allowed environment.
 */
export function NodeTrust({ nodeId }: { nodeId: string }) {
	const trust = useLoad(() => api.getNodeTrust(nodeId), [nodeId]);
	const t = trust.data;
	return (
		<section>
			<div className="row">
				<h2>Trust</h2>
				<span className="spacer" />
				<button type="button" onClick={trust.reload}>
					Refresh
				</button>
			</div>
			<Loading loading={trust.loading && !t} error={trust.error} />
			{t && (
				<>
					<dl className="kv">
						<dt>Report</dt>
						<dd>
							{t.status ?? "not reported"}
							{t.stale && <span className="muted"> (last report, stale until the node reconnects)</span>}
						</dd>
						{t.message && (
							<>
								<dt>Message</dt>
								<dd>{t.message}</dd>
							</>
						)}
						<dt>Digest</dt>
						<dd className="mono">{t.digest ?? "-"}</dd>
						<dt>Updated</dt>
						<dd>{formatTime(t.updatedAt)}</dd>
					</dl>
					{t.summary && t.summary.trust.length === 0 && <p className="muted">The node trusts nobody.</p>}
					{t.summary && t.summary.trust.length > 0 && (
						<div className="scroll-x">
							<table>
								<thead>
									<tr>
										<th>Name</th>
										<th>Role</th>
										<th>Format</th>
										<th>Kinds</th>
										<th>Flags</th>
										<th>Max TTL</th>
										<th>Key</th>
									</tr>
								</thead>
								<tbody>
									{t.summary.trust.map((entry) => (
										<tr key={entry.name}>
											<td>{entry.name}</td>
											<td>{entry.role}</td>
											<td>{entry.key.kind}</td>
											<td>{entry.kinds.join(", ") || "-"}</td>
											<td>{flags(entry)}</td>
											<td>{ttlText(entry.maxTtlMs)}</td>
											<td className="mono">{keyText(entry.key)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					{t.summary?.trust.map((entry) => (
						<details key={entry.name}>
							<summary>{entry.name} rules</summary>
							<dl className="kv">
								<dt>Allow</dt>
								<dd>{entry.allow.map(guardRuleText).join("; ") || "any method and target"}</dd>
								<dt>Deny</dt>
								<dd>{entry.deny.map(guardRuleText).join("; ") || "-"}</dd>
								<dt>Environment</dt>
								<dd>{entry.envAllow.join(", ") || "-"}</dd>
								{entry.key.publicKey && (
									<>
										<dt>Public key</dt>
										<dd className="mono">{entry.key.publicKey}</dd>
									</>
								)}
							</dl>
						</details>
					))}
					{!t.status && <p className="muted">The node has not reported its trust configuration.</p>}
				</>
			)}
		</section>
	);
}
