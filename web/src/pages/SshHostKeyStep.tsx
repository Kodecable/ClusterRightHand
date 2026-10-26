import { useState } from "react";
import { api, type SshTargetBody } from "../api.ts";
import { ErrorText } from "../components/Feedback.tsx";
import { useAction } from "../hooks.ts";
import { firstUnpinned, type Hop, hopBodies, pinHop } from "../sshHops.ts";

const label = (hops: Hop[], i: number) => (i === hops.length - 1 ? "target" : `jump host ${i + 1}`);

/** Wizard step 3: probe each unpinned hop in turn and pin its fingerprint once the user confirms it. */
export function SshHostKeyStep({
	hops,
	credentialId,
	onHops,
}: {
	hops: Hop[];
	credentialId: string;
	onHops: (h: Hop[]) => void;
}) {
	const [candidate, setCandidate] = useState<{ hop: number; fingerprint: string }>();
	const { busy, error, run } = useAction();
	const next = firstUnpinned(hops);
	const probe = async () => {
		const body: SshTargetBody = { ...hopBodies(hops), credentialId };
		const r = await run(() => api.probeSshHost(body));
		if (r) setCandidate(r);
	};
	const confirm = () => {
		if (!candidate) return;
		onHops(pinHop(hops, candidate.hop, candidate.fingerprint));
		setCandidate(undefined);
	};
	return (
		<div className="stack">
			<ul>
				{hops.map((h, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: hops are identified by position
					<li key={i}>
						{label(hops, i)}{" "}
						<code>
							{h.host}:{h.port}
						</code>{" "}
						{h.hostKey ? <code>{h.hostKey}</code> : <span className="muted">not checked</span>}
					</li>
				))}
			</ul>
			{candidate && (
				<div className="stack">
					<p>
						Host key of {label(hops, candidate.hop)} <code>{hops[candidate.hop]?.host}</code>:
					</p>
					<p className="fingerprint mono">{candidate.fingerprint}</p>
					<p className="muted">
						Compare with <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on that host. Only confirm if
						they match.
					</p>
					<div className="row">
						<button type="button" className="primary" onClick={confirm}>
							It matches, pin it
						</button>
						<button type="button" onClick={() => setCandidate(undefined)}>
							Discard
						</button>
					</div>
				</div>
			)}
			{!candidate && next >= 0 && (
				<div className="row">
					<button type="button" className="primary" onClick={probe} disabled={busy}>
						{busy ? "Connecting…" : `Check host key of ${label(hops, next)}`}
					</button>
				</div>
			)}
			{next < 0 && <p>All host keys are confirmed.</p>}
			<ErrorText error={error} />
		</div>
	);
}
