import { type FormEvent, useState } from "react";
import { api, type CompatibleModel, type ModelProviderView } from "../api.ts";
import { Badge, ErrorText, Loading } from "../components/Feedback.tsx";
import { Modal } from "../components/Modal.tsx";
import { useAction, useLoad } from "../hooks.ts";

interface ModelRow {
	id: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
}

const toRows = (models: CompatibleModel[] | null): ModelRow[] =>
	(models ?? []).map((m) => ({
		id: m.id,
		contextWindow: String(m.contextWindow),
		maxTokens: String(m.maxTokens),
		reasoning: m.reasoning === true,
	}));

/** Rows to the API shape; undefined with a message when a number is not a positive integer. */
export function rowsToModels(rows: ModelRow[]): { models: CompatibleModel[] } | { error: string } {
	const models: CompatibleModel[] = [];
	for (const r of rows) {
		const id = r.id.trim();
		const contextWindow = Number(r.contextWindow);
		const maxTokens = Number(r.maxTokens);
		if (!id) return { error: "Every model needs an id." };
		if (!Number.isInteger(contextWindow) || contextWindow <= 0)
			return { error: `Model ${id}: context window must be a positive whole number.` };
		if (!Number.isInteger(maxTokens) || maxTokens <= 0)
			return { error: `Model ${id}: max tokens must be a positive whole number.` };
		models.push({ id, contextWindow, maxTokens, ...(r.reasoning ? { reasoning: true } : {}) });
	}
	return { models };
}

function ProviderDialog({
	existing,
	builtin,
	onClose,
	onSaved,
}: {
	existing: ModelProviderView | undefined;
	builtin: string[];
	onClose: () => void;
	onSaved: () => void;
}) {
	const [kind, setKind] = useState<"builtin" | "openai-compatible">(existing?.kind ?? "builtin");
	const [providerId, setProviderId] = useState(existing?.providerId ?? builtin[0] ?? "");
	const [name, setName] = useState(existing?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState("");
	const [removeKey, setRemoveKey] = useState(false);
	const [enabled, setEnabled] = useState(existing?.enabled ?? true);
	const [rows, setRows] = useState<ModelRow[]>(() =>
		existing?.models?.length
			? toRows(existing.models)
			: [{ id: "", contextWindow: "128000", maxTokens: "8192", reasoning: false }],
	);
	const { busy, error, run, setError } = useAction();
	const editing = existing !== undefined;
	const compatible = kind === "openai-compatible";

	const setRow = (i: number, patch: Partial<ModelRow>) =>
		setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const body: Parameters<typeof api.saveModelProvider>[1] = { kind, enabled };
		if (compatible) {
			const parsed = rowsToModels(rows);
			if ("error" in parsed) return setError(parsed.error);
			body.name = name.trim() || providerId;
			body.baseUrl = baseUrl.trim();
			body.models = parsed.models;
		}
		if (removeKey) body.apiKey = null;
		else if (apiKey) body.apiKey = apiKey;
		if (await run(() => api.saveModelProvider(providerId, body))) {
			onSaved();
			onClose();
		}
	};

	return (
		<Modal title={editing ? `Edit provider ${existing.providerId}` : "Add model provider"} onClose={onClose}>
			<form onSubmit={submit} className="stack">
				<label>
					Kind
					<select value={kind} disabled={editing} onChange={(e) => setKind(e.target.value as typeof kind)}>
						<option value="builtin">Built-in provider</option>
						<option value="openai-compatible">OpenAI-compatible endpoint</option>
					</select>
				</label>
				{kind === "builtin" ? (
					<label>
						Provider
						<select value={providerId} disabled={editing} onChange={(e) => setProviderId(e.target.value)}>
							{builtin.map((b) => (
								<option key={b} value={b}>
									{b}
								</option>
							))}
						</select>
					</label>
				) : (
					<>
						<label>
							Provider id
							<input
								value={providerId}
								onChange={(e) => setProviderId(e.target.value)}
								readOnly={editing}
								required
								pattern="[a-z0-9][a-z0-9\-]{0,63}"
								title="Lowercase letters, digits and -"
							/>
						</label>
						<label>
							Name
							<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
						</label>
						<label>
							Base URL
							<input
								type="url"
								value={baseUrl}
								onChange={(e) => setBaseUrl(e.target.value)}
								required
								placeholder="https://api.example.com/v1"
							/>
						</label>
						<fieldset>
							<legend>Models</legend>
							<div className="scroll-x">
								<table aria-label="Models">
									<thead>
										<tr>
											<th>Id</th>
											<th>Context window</th>
											<th>Max tokens</th>
											<th>Reasoning</th>
											<th />
										</tr>
									</thead>
									<tbody>
										{rows.map((r, i) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable identity while editing
											<tr key={i}>
												<td>
													<input
														aria-label={`Model ${i + 1} id`}
														value={r.id}
														onChange={(e) => setRow(i, { id: e.target.value })}
													/>
												</td>
												<td>
													<input
														aria-label={`Model ${i + 1} context window`}
														inputMode="numeric"
														value={r.contextWindow}
														onChange={(e) => setRow(i, { contextWindow: e.target.value })}
													/>
												</td>
												<td>
													<input
														aria-label={`Model ${i + 1} max tokens`}
														inputMode="numeric"
														value={r.maxTokens}
														onChange={(e) => setRow(i, { maxTokens: e.target.value })}
													/>
												</td>
												<td>
													<input
														type="checkbox"
														aria-label={`Model ${i + 1} reasoning`}
														checked={r.reasoning}
														onChange={(e) => setRow(i, { reasoning: e.target.checked })}
													/>
												</td>
												<td>
													<button
														type="button"
														disabled={rows.length === 1}
														onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
														aria-label={`Remove model ${i + 1}`}
													>
														Remove
													</button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<button
								type="button"
								onClick={() =>
									setRows((rs) => [...rs, { id: "", contextWindow: "128000", maxTokens: "8192", reasoning: false }])
								}
							>
								Add model
							</button>
						</fieldset>
					</>
				)}
				<label>
					API key
					<input
						type="password"
						autoComplete="off"
						value={apiKey}
						disabled={removeKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder={existing?.hasApiKey ? "Leave empty to keep the current key" : ""}
					/>
				</label>
				{existing?.hasApiKey && (
					<label className="inline">
						<input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} />
						Remove the stored key
					</label>
				)}
				<label className="inline">
					<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
					Enabled
				</label>
				<ErrorText error={error} />
				<div className="row end">
					<button type="button" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="primary" disabled={busy || !providerId}>
						Save provider
					</button>
				</div>
			</form>
		</Modal>
	);
}

function DeleteDialog({
	provider,
	onClose,
	onDeleted,
}: {
	provider: ModelProviderView;
	onClose: () => void;
	onDeleted: () => void;
}) {
	const { busy, error, run } = useAction();
	return (
		<Modal title={`Delete provider ${provider.providerId}?`} onClose={onClose}>
			<p>
				Its models disappear from the model lists, and its stored key is deleted. Existing sessions that use them stop
				working until you change their model.
			</p>
			<ErrorText error={error} />
			<div className="row end">
				<button type="button" onClick={onClose}>
					Cancel
				</button>
				<button
					type="button"
					className="danger"
					disabled={busy}
					onClick={async () => {
						if (await run(() => api.deleteModelProvider(provider.providerId))) {
							onDeleted();
							onClose();
						}
					}}
				>
					Delete provider
				</button>
			</div>
		</Modal>
	);
}

export function ModelSettings() {
	const { data, error, loading, reload } = useLoad(() => api.listModelProviders(), []);
	const [editing, setEditing] = useState<ModelProviderView | "new">();
	const [deleting, setDeleting] = useState<ModelProviderView>();
	return (
		<>
			<h1>Model providers</h1>
			<p className="muted">Sessions use the models of the enabled providers below.</p>
			<div className="row">
				<button type="button" className="primary" onClick={() => setEditing("new")}>
					Add provider
				</button>
			</div>
			<Loading loading={loading && !data} error={error} />
			{data && data.providers.length === 0 && <p className="muted">No model providers yet.</p>}
			{data && data.providers.length > 0 && (
				<div className="scroll-x">
					<table aria-label="Model providers">
						<thead>
							<tr>
								<th>Id</th>
								<th>Kind</th>
								<th>Name</th>
								<th>Base URL</th>
								<th>API key</th>
								<th>Status</th>
								<th>Models</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{data.providers.map((p) => (
								<tr key={p.id}>
									<td className="mono">{p.providerId}</td>
									<td>{p.kind === "builtin" ? "built-in" : "OpenAI-compatible"}</td>
									<td>{p.name}</td>
									<td className="mono">{p.baseUrl ?? "-"}</td>
									<td>{p.hasApiKey ? <Badge kind="ok">set</Badge> : <Badge kind="off">not set</Badge>}</td>
									<td>{p.enabled ? <Badge kind="ok">enabled</Badge> : <Badge kind="off">disabled</Badge>}</td>
									<td>{p.models ? p.models.map((m) => m.id).join(", ") : "all built-in models"}</td>
									<td className="actions">
										<button type="button" onClick={() => setEditing(p)} aria-label={`Edit ${p.providerId}`}>
											Edit
										</button>
										<button
											type="button"
											className="danger"
											onClick={() => setDeleting(p)}
											aria-label={`Delete ${p.providerId}`}
										>
											Delete
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{editing && data && (
				<ProviderDialog
					existing={editing === "new" ? undefined : editing}
					builtin={data.builtin}
					onClose={() => setEditing(undefined)}
					onSaved={reload}
				/>
			)}
			{deleting && <DeleteDialog provider={deleting} onClose={() => setDeleting(undefined)} onDeleted={reload} />}
		</>
	);
}
