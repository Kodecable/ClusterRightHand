import { type FormEvent, useState } from "react";
import { api, type PublicNode } from "../api.ts";
import { ErrorText } from "../components/Feedback.tsx";
import { useAction } from "../hooks.ts";

export function RenameNode({ node, onDone }: { node: PublicNode; onDone: () => void }) {
	const [name, setName] = useState<string>();
	const { busy, error, run, setError } = useAction();
	if (name === undefined)
		return (
			<button type="button" onClick={() => setName(node.name)}>
				Rename
			</button>
		);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (await run(() => api.renameNode(node.id, name.trim()))) {
			setName(undefined);
			onDone();
		}
	};
	return (
		<form onSubmit={submit} className="row">
			<input value={name} onChange={(e) => setName(e.target.value)} required aria-label="New name" />
			<button type="submit" className="primary" disabled={busy || !name.trim()}>
				Save
			</button>
			<button
				type="button"
				onClick={() => {
					setName(undefined);
					setError(undefined);
				}}
			>
				Cancel
			</button>
			<ErrorText error={error} />
		</form>
	);
}
