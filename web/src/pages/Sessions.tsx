import { type FormEvent, useState } from "react";
import { type AvailableModel, api, type ModelRef, type Preset } from "../api.ts";
import { useUser } from "../auth.tsx";
import { ErrorText, Loading } from "../components/Feedback.tsx";
import { Modal } from "../components/Modal.tsx";
import { ModelSelect, PresetSelect } from "../components/ModelSelect.tsx";
import { useAction, useLoad } from "../hooks.ts";
import { formatTime, parseQuotaInput } from "../lib.ts";
import { navigate } from "../router.ts";

function NewSession({ models, onClose }: { models: AvailableModel[]; onClose: () => void }) {
	const [title, setTitle] = useState("");
	const [model, setModel] = useState<ModelRef | undefined>(
		models[0] && { provider: models[0].provider, modelId: models[0].modelId },
	);
	const [preset, setPreset] = useState<Preset>("ask");
	const [quotaText, setQuotaText] = useState("");
	const [quotaError, setQuotaError] = useState<string>();
	const { busy, error, run } = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!model) return;
		// Empty means unlimited; a root without a quota is never charged (doc/agent-runtime.md#配额).
		const quota = parseQuotaInput(quotaText);
		if ("error" in quota) {
			setQuotaError(quota.error);
			return;
		}
		setQuotaError(undefined);
		const s = await run(() =>
			api.createSession({ ...(title.trim() ? { title: title.trim() } : {}), model, preset, quota: quota.quota }),
		);
		if (s) navigate(`/sessions/${s.id}`);
	};
	return (
		<Modal title="New session" onClose={onClose}>
			<form onSubmit={submit} className="stack">
				<label>
					Title
					<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="New session" />
				</label>
				<ModelSelect models={models} value={model} onChange={setModel} />
				<PresetSelect value={preset} onChange={(p) => setPreset(p)} />
				<label>
					Token quota (empty = unlimited)
					<input
						inputMode="numeric"
						value={quotaText}
						onChange={(e) => setQuotaText(e.target.value)}
						placeholder="unlimited"
					/>
				</label>
				{preset === "yolo" && <p className="warn">Yolo lets the agent run anything on your nodes without asking.</p>}
				<ErrorText error={quotaError ?? error} />
				<div className="row end">
					<button type="button" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="primary" disabled={busy || !model}>
						Create session
					</button>
				</div>
			</form>
		</Modal>
	);
}

export function Sessions() {
	const user = useUser();
	const sessions = useLoad(() => api.listSessions(), []);
	const models = useLoad(() => api.listModels(), []);
	const [creating, setCreating] = useState(false);
	const noModels = models.data !== undefined && models.data.length === 0;
	return (
		<>
			<h1>Sessions</h1>
			<p className="muted">Chat with the agent; it operates your nodes through the same rules as everything else.</p>
			<div className="row">
				<button type="button" className="primary" onClick={() => setCreating(true)} disabled={!models.data?.length}>
					New session
				</button>
			</div>
			{noModels && (
				<p className="warn" role="status">
					No models are configured, so sessions cannot start.{" "}
					{user.kind === "admin" ? (
						<a href="#/settings/models">Configure a model provider</a>
					) : (
						"Ask an administrator to configure one."
					)}
				</p>
			)}
			<ErrorText error={models.error} />
			<Loading loading={sessions.loading && !sessions.data} error={sessions.error} />
			{sessions.data && sessions.data.length === 0 && <p className="muted">No sessions yet.</p>}
			{sessions.data && sessions.data.length > 0 && (
				<div className="scroll-x">
					<table aria-label="Sessions">
						<thead>
							<tr>
								<th>Title</th>
								<th>Owner</th>
								<th>Model</th>
								<th>Preset</th>
								<th>Updated</th>
							</tr>
						</thead>
						<tbody>
							{[...sessions.data]
								.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
								.map((s) => (
									<tr key={s.id}>
										<td>
											<a href={`#/sessions/${encodeURIComponent(s.id)}`}>{s.title}</a>
											{s.relationship !== "owner" && (
												<span className="muted">
													{" · "}
													{s.relationship === "shared"
														? `shared (${s.capabilities.chat ? "chat" : "view"})`
														: s.relationship}
												</span>
											)}
										</td>
										<td>{s.ownerUsername ?? "-"}</td>
										<td>
											{s.model.provider}/{s.model.modelId}
										</td>
										<td>{s.rules?.preset ?? "-"}</td>
										<td>{formatTime(s.updatedAt)}</td>
									</tr>
								))}
						</tbody>
					</table>
				</div>
			)}
			{creating && models.data && <NewSession models={models.data} onClose={() => setCreating(false)} />}
		</>
	);
}
