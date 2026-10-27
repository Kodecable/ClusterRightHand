import { useState } from "react";

export function ErrorText({ error }: { error: string | undefined }) {
	return error ? (
		<p className="error" role="alert">
			{error}
		</p>
	) : null;
}

export function Loading({ loading, error }: { loading: boolean; error?: string }) {
	if (error) return <ErrorText error={error} />;
	return loading ? <p className="muted">Loading…</p> : null;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
	const [done, setDone] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setDone(true);
			setTimeout(() => setDone(false), 1500);
		} catch {
			setDone(false);
		}
	};
	return (
		<button type="button" onClick={copy}>
			{done ? "Copied" : label}
		</button>
	);
}

export function Badge({ kind, children }: { kind: string; children: string }) {
	return <span className={`badge badge-${kind}`}>{children}</span>;
}

/** Online/offline for crha nodes; nothing for SSH nodes. */
export function LinkBadge({ connected }: { connected: boolean | null }) {
	if (connected === null) return null;
	return connected ? <Badge kind="ok">online</Badge> : <Badge kind="off">offline</Badge>;
}
