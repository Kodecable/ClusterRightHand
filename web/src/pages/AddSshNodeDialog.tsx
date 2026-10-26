import { useState } from "react";
import { api } from "../api.ts";
import { ErrorText } from "../components/Feedback.tsx";
import { Modal } from "../components/Modal.tsx";
import { useAction } from "../hooks.ts";
import { parseList } from "../lib.ts";
import { emptyHop, firstUnpinned, type Hop, hopBodies, validateHops } from "../sshHops.ts";
import { SshCredentialStep } from "./SshCredentialStep.tsx";
import { SshHostKeyStep } from "./SshHostKeyStep.tsx";
import { SshRouteStep } from "./SshRouteStep.tsx";

const STEPS = ["Credential", "Target", "Host keys", "Create"];

export function AddSshNodeDialog({ onClose }: { onClose: () => void }) {
	const [step, setStep] = useState(0);
	const [credentialId, setCredentialId] = useState("");
	const [hops, setHops] = useState<Hop[]>([emptyHop()]);
	const [name, setName] = useState("");
	const [groups, setGroups] = useState("");
	const [stepError, setStepError] = useState<string>();
	const { busy, error, run } = useAction();

	const go = (to: number) => {
		setStepError(undefined);
		if (to > step) {
			if (step === 0 && !credentialId) return setStepError("choose or create a credential");
			if (step === 1) {
				const bad = validateHops(hops);
				if (bad) return setStepError(bad);
			}
			if (step === 2 && firstUnpinned(hops) >= 0) return setStepError("confirm every host key first");
		}
		setStep(to);
	};
	const create = async () => {
		const body = {
			...hopBodies(hops),
			credentialId,
			name: name.trim(),
			groups: parseList(groups.replaceAll(",", " ")),
		};
		const node = await run(() => api.createSshNode(body));
		if (node) {
			onClose();
			location.hash = `#/nodes/${node.id}`;
		}
	};
	const target = hops[hops.length - 1] as Hop;
	return (
		<Modal title="Add SSH node" onClose={onClose}>
			<div className="stack">
				<ol className="steps">
					{STEPS.map((s, i) => (
						<li key={s} aria-current={i === step ? "step" : undefined}>
							{i + 1}. {s}
						</li>
					))}
				</ol>
				{step === 0 && <SshCredentialStep value={credentialId} onChange={setCredentialId} />}
				{step === 1 && (
					<SshRouteStep
						hops={hops}
						onHops={setHops}
						name={name}
						onName={setName}
						groups={groups}
						onGroups={setGroups}
					/>
				)}
				{step === 2 && <SshHostKeyStep hops={hops} credentialId={credentialId} onHops={setHops} />}
				{step === 3 && (
					<div className="stack">
						<dl className="kv">
							<dt>Node name</dt>
							<dd>{name.trim() || target.host}</dd>
							<dt>Route</dt>
							<dd>{hops.map((h) => `${h.user}@${h.host}:${h.port}`).join(" → ")}</dd>
							<dt>Groups</dt>
							<dd>{parseList(groups.replaceAll(",", " ")).join(", ") || "-"}</dd>
						</dl>
						<p className="muted">
							The node is active as soon as it is created; the pinned host keys are enforced on every connection.
						</p>
					</div>
				)}
				<ErrorText error={stepError ?? error} />
				<div className="row end">
					{step > 0 && (
						<button type="button" onClick={() => go(step - 1)}>
							Back
						</button>
					)}
					{step < 3 ? (
						<button type="button" className="primary" onClick={() => go(step + 1)}>
							Next
						</button>
					) : (
						<button type="button" className="primary" onClick={create} disabled={busy}>
							Create node
						</button>
					)}
					<button type="button" onClick={onClose}>
						Cancel
					</button>
				</div>
			</div>
		</Modal>
	);
}
