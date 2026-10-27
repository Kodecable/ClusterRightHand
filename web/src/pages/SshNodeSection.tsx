import { type FormEvent, useState } from "react";
import { api, type PublicNode, type SshNodeDetails } from "../api.ts";
import { ErrorText } from "../components/Feedback.tsx";
import { TestConnection } from "../components/TestConnection.tsx";
import { useAction } from "../hooks.ts";
import { parseList } from "../lib.ts";

function GroupsEditor({ node, onDone }: { node: PublicNode; onDone: () => void }) {
	const [value, setValue] = useState<string>();
	const { busy, error, run, setError } = useAction();
	if (value === undefined)
		return (
			<button type="button" onClick={() => setValue(node.groups.join(", "))}>
				Edit groups
			</button>
		);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (await run(() => api.setNodeGroups(node.id, parseList(value.replaceAll(",", " "))))) {
			setValue(undefined);
			onDone();
		}
	};
	return (
		<form onSubmit={submit} className="row wrap">
			<label>
				Groups (comma separated)
				<input value={value} onChange={(e) => setValue(e.target.value)} />
			</label>
			<button type="submit" className="primary" disabled={busy}>
				Save
			</button>
			<button
				type="button"
				onClick={() => {
					setValue(undefined);
					setError(undefined);
				}}
			>
				Cancel
			</button>
			<ErrorText error={error} />
		</form>
	);
}

/** Route, pinned host keys, credential and groups of an SSH node, with a connection test. */
export function SshNodeSection({
	node,
	details,
	canRun,
	onChange,
}: {
	node: PublicNode;
	details: SshNodeDetails | null | undefined;
	canRun: boolean;
	onChange: () => void;
}) {
	const canManage = node.access === "owner" || node.access === "admin";
	return (
		<section aria-label="SSH">
			<h2>SSH</h2>
			{details && (
				<>
					<table>
						<thead>
							<tr>
								<th>Hop</th>
								<th>Address</th>
								<th>Pinned host key</th>
							</tr>
						</thead>
						<tbody>
							{details.hops.map((h, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: hops have no identity beyond their position
								<tr key={i}>
									<td>{i === details.hops.length - 1 ? "target" : `jump host ${i + 1}`}</td>
									<td className="mono">
										{h.user}@{h.host}:{h.port}
									</td>
									<td className="mono">{h.hostKey}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="muted">Credential: {details.credential.name ?? details.credential.id}</p>
				</>
			)}
			<div className="row wrap">
				{canRun && <TestConnection test={() => api.testSshNode(node.id)} />}
				{canManage && <GroupsEditor node={node} onDone={onChange} />}
			</div>
		</section>
	);
}
