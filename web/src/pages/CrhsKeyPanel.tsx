import { useState } from "react";
import { api } from "../api.ts";
import { CopyButton, Loading } from "../components/Feedback.tsx";
import { useLoad } from "../hooks.ts";
import { trustSnippet } from "../lib.ts";

/**
 * crhs's authorization signing key (doc/privilege.md#授权签名密钥): the authorized_keys line and the
 * fingerprint to trust on a node, and the ready-made `[[trust]]` block for privileged.toml.
 */
export function CrhsKeyPanel() {
	const key = useLoad(() => api.getCrhsKey(), []);
	const [snippet, setSnippet] = useState(false);
	const k = key.data;
	return (
		<section>
			<h2>crhs signing key</h2>
			<Loading loading={key.loading && !k} error={key.error} />
			{k && (
				<>
					<p className="muted">
						A node authorizes privileged tasks signed by this key when its privileged.toml trusts the key below.
					</p>
					<dl className="kv">
						<dt>Fingerprint</dt>
						<dd className="mono">{k.fingerprint}</dd>
						<dt>Public key</dt>
						<dd className="mono">{k.authorizedKey}</dd>
					</dl>
					<div className="row">
						<button type="button" onClick={() => setSnippet((shown) => !shown)}>
							{snippet ? "Hide trust snippet" : "Export trust snippet"}
						</button>
						{snippet && <CopyButton text={trustSnippet(k.authorizedKey)} label="Copy snippet" />}
					</div>
					{snippet && <pre className="output">{trustSnippet(k.authorizedKey)}</pre>}
				</>
			)}
		</section>
	);
}
