import { type FormEvent, useState } from "react";
import { type ApiTokenView, api, type Preset } from "../api.ts";
import { Badge, CopyButton, ErrorText, Loading } from "../components/Feedback.tsx";
import { Modal } from "../components/Modal.tsx";
import { useAction, useLoad } from "../hooks.ts";
import { formatTime, mcpCommand, tokenStatus } from "../lib.ts";

const PRESET_HELP: Record<Preset, string> = {
	ask: "Ask: ordinary reads run, everything else (including every privileged task) waits for your approval",
	yolo: "Yolo: everything runs without asking",
	auto_review: "Auto Review: needs a model, coming later",
};

function CreateToken({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
	const [name, setName] = useState("");
	const [preset, setPreset] = useState<Preset>("ask");
	const [days, setDays] = useState("90");
	const [created, setCreated] = useState<string>();
	const { busy, error, run } = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const r = await run(() => api.createApiToken({ name, preset, days: days === "never" ? null : Number(days) }));
		if (r) {
			setCreated(r.token);
			onCreated();
		}
	};
	if (created) {
		return (
			<Modal title="Token created" onClose={onClose}>
				<p>
					<strong>Copy this token now. It will not be shown again.</strong>
				</p>
				<div className="row wrap">
					<section aria-label="API token">
						<code className="mono">{created}</code>
					</section>
					<CopyButton text={created} label="Copy token" />
				</div>
				<p>Connect Claude Code with:</p>
				<section aria-label="Claude Code command">
					<pre className="output">{mcpCommand(location.origin, created)}</pre>
				</section>
				<div className="row">
					<CopyButton text={mcpCommand(location.origin, created)} label="Copy command" />
					<span className="spacer" />
					<button type="button" className="primary" onClick={onClose}>
						Done
					</button>
				</div>
			</Modal>
		);
	}
	return (
		<Modal title="Create API token" onClose={onClose}>
			<form onSubmit={submit} className="stack">
				<label>
					Name
					<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
				</label>
				<label>
					Preset
					<select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
						<option value="ask">
							Ask - ordinary reads run, everything else (including privileged tasks) waits for your approval
						</option>
						<option value="yolo">Yolo - everything runs without asking</option>
						<option value="auto_review" disabled>
							Auto Review (needs a model, coming later)
						</option>
					</select>
				</label>
				<label>
					Expires after
					<select value={days} onChange={(e) => setDays(e.target.value)}>
						<option value="30">30 days</option>
						<option value="90">90 days</option>
						<option value="365">365 days</option>
						<option value="never">never</option>
					</select>
				</label>
				{days === "never" && <p className="warn">A token that never expires stays valid until you revoke it.</p>}
				{preset === "yolo" && <p className="warn">Yolo lets this token run anything on your nodes without asking.</p>}
				<ErrorText error={error} />
				<div className="row end">
					<button type="button" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="primary" disabled={busy}>
						Create token
					</button>
				</div>
			</form>
		</Modal>
	);
}

function RulesEditor({ token, onChange }: { token: ApiTokenView; onChange: () => void }) {
	const [preset, setPreset] = useState<Preset>(token.rules?.preset ?? "ask");
	const [text, setText] = useState(() => JSON.stringify({ rules: token.rules?.rules ?? [] }, null, 2));
	const [rulesOpen, setRulesOpen] = useState(false);
	const presetAction = useAction();
	const rulesAction = useAction();
	const savePreset = async () => {
		if (await presetAction.run(() => api.setTokenRules(token.id, { preset }))) onChange();
	};
	const saveRules = async () => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (e) {
			rulesAction.setError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		const rules = (parsed as { rules?: unknown } | null)?.rules;
		if (!Array.isArray(rules)) {
			rulesAction.setError('Expected an object like {"rules": [...]}');
			return;
		}
		if (await rulesAction.run(() => api.setTokenRules(token.id, { rules: rules as never }))) onChange();
	};
	return (
		<div className="stack">
			<div className="row wrap">
				<label>
					Preset
					<select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
						<option value="ask">ask</option>
						<option value="yolo">yolo</option>
						<option value="auto_review" disabled>
							auto_review (needs a model, coming later)
						</option>
					</select>
				</label>
				<button type="button" onClick={savePreset} disabled={presetAction.busy || preset === token.rules?.preset}>
					Save preset
				</button>
				<span className="muted">{PRESET_HELP[preset]}</span>
			</div>
			<ErrorText error={presetAction.error} />
			<div>
				<button type="button" onClick={() => setRulesOpen((o) => !o)} aria-expanded={rulesOpen}>
					{rulesOpen ? "Hide added rules" : `Added rules (${token.rules?.rules.length ?? 0})`}
				</button>
			</div>
			{rulesOpen && (
				<>
					<label>
						Rules as JSON
						<textarea className="mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
					</label>
					<p className="muted">
						Each rule: action (allow, deny, require-approval), optional method (exec, file.read, file.write), nodes, and
						exact or prefix.
					</p>
					<ErrorText error={rulesAction.error} />
					<div className="row">
						<button type="button" onClick={saveRules} disabled={rulesAction.busy}>
							Save rules
						</button>
					</div>
				</>
			)}
		</div>
	);
}

function TokenRow({ token, onChange }: { token: ApiTokenView; onChange: () => void }) {
	const [open, setOpen] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const { busy, error, run } = useAction();
	const status = tokenStatus(token);
	const revoke = async () => {
		if (await run(() => api.revokeApiToken(token.id))) {
			setConfirm(false);
			onChange();
		}
	};
	const remove = async () => {
		if (await run(() => api.deleteApiToken(token.id))) onChange();
	};
	return (
		<>
			<tr>
				<td>{token.name}</td>
				<td>{token.rules?.preset ?? "-"}</td>
				<td>{formatTime(token.createdAt)}</td>
				<td>{token.expiresAt ? formatTime(token.expiresAt) : <Badge kind="warn">never</Badge>}</td>
				<td>{formatTime(token.lastUsedAt)}</td>
				<td>
					<Badge kind={status === "active" ? "ok" : "bad"}>{status}</Badge>
				</td>
				<td className="actions">
					{status === "active" && (
						<button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
							{open ? "Close" : "Rules"}
						</button>
					)}
					{status === "active" && (
						<button type="button" className="danger" onClick={() => setConfirm(true)}>
							Revoke
						</button>
					)}
					{status !== "active" && (
						<button type="button" className="danger" disabled={busy} onClick={remove}>
							Delete
						</button>
					)}
				</td>
			</tr>
			{open && (
				<tr>
					<td colSpan={7}>
						<RulesEditor token={token} onChange={onChange} />
					</td>
				</tr>
			)}
			{error && !confirm && (
				<tr>
					<td colSpan={7}>
						<ErrorText error={error} />
					</td>
				</tr>
			)}
			{confirm && (
				<tr>
					<td colSpan={7}>
						<Modal title={`Revoke token ${token.name}?`} onClose={() => setConfirm(false)}>
							<p>Anything using this token stops working immediately. This cannot be undone.</p>
							<ErrorText error={error} />
							<div className="row end">
								<button type="button" onClick={() => setConfirm(false)}>
									Cancel
								</button>
								<button type="button" className="danger" disabled={busy} onClick={revoke}>
									Revoke token
								</button>
							</div>
						</Modal>
					</td>
				</tr>
			)}
		</>
	);
}

export function Tokens() {
	const { data, error, loading, reload } = useLoad(() => api.listApiTokens(), []);
	const [creating, setCreating] = useState(false);
	return (
		<>
			<h1>API tokens</h1>
			<p className="muted">
				API tokens let tools such as Claude Code use your nodes through MCP. Each token has its own rules; what they do
				not allow waits for your approval.
			</p>
			<div className="row">
				<button type="button" className="primary" onClick={() => setCreating(true)}>
					Create token
				</button>
			</div>
			<Loading loading={loading && !data} error={error} />
			{data && data.length === 0 && <p className="muted">No API tokens yet.</p>}
			{data && data.length > 0 && (
				<div className="scroll-x">
					<table aria-label="API tokens">
						<thead>
							<tr>
								<th>Name</th>
								<th>Preset</th>
								<th>Created</th>
								<th>Expires</th>
								<th>Last used</th>
								<th>Status</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{data.map((t) => (
								<TokenRow key={t.id} token={t} onChange={reload} />
							))}
						</tbody>
					</table>
				</div>
			)}
			{creating && <CreateToken onClose={() => setCreating(false)} onCreated={reload} />}
		</>
	);
}
