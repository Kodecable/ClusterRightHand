import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, type TaskView } from "../api.ts";
import { ErrorText } from "../components/Feedback.tsx";
import { TaskResult } from "../components/TaskResult.tsx";
import { errMsg, useAction } from "../hooks.ts";
import { isTerminal } from "../lib.ts";
import { buildTaskRequest, emptyForm, KINDS, type Kind, type TaskForm } from "../taskForm.ts";

export function RunPanel({ nodeId, onDone }: { nodeId: string; onDone: () => void }) {
	const [form, setForm] = useState<TaskForm>(emptyForm);
	const [task, setTask] = useState<TaskView>();
	const [error, setError] = useState<string>();
	const cancel = useAction();
	const abort = useRef<AbortController>(undefined);
	const running = task !== undefined && !isTerminal(task.state);
	useEffect(() => () => abort.current?.abort(), []);

	const set = <K extends keyof TaskForm>(k: K, v: TaskForm[K]) => setForm((f) => ({ ...f, [k]: v }));
	const text = (k: keyof TaskForm, label: string, opts: { area?: boolean; mono?: boolean } = {}) => (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is rendered inside the label below
		<label>
			{label}
			{opts.area ? (
				<textarea
					rows={4}
					className="mono"
					value={form[k] as string}
					onChange={(e) => set(k, e.target.value as never)}
				/>
			) : (
				<input
					className={opts.mono ? "mono" : undefined}
					value={form[k] as string}
					onChange={(e) => set(k, e.target.value as never)}
				/>
			)}
		</label>
	);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setError(undefined);
		abort.current?.abort();
		const ctl = new AbortController();
		abort.current = ctl;
		try {
			let t = await api.createTask(nodeId, buildTaskRequest(form));
			setTask(t);
			while (!isTerminal(t.state) && !ctl.signal.aborted) {
				t = await api.waitTask(t.id, 20000, ctl.signal);
				setTask(t);
			}
		} catch (err) {
			if (!ctl.signal.aborted) setError(errMsg(err));
		}
		if (!ctl.signal.aborted) onDone();
	};

	const isFile = form.kind !== "exec";
	return (
		<section>
			<h2>Run</h2>
			<form onSubmit={submit} className="stack">
				<div className="row wrap">
					<label>
						Kind
						<select value={form.kind} onChange={(e) => set("kind", e.target.value as Kind)}>
							{KINDS.map((k) => (
								<option key={k}>{k}</option>
							))}
						</select>
					</label>
					<label>
						Timeout (s)
						<input
							value={form.timeoutSec}
							inputMode="numeric"
							size={6}
							onChange={(e) => set("timeoutSec", e.target.value)}
						/>
					</label>
				</div>
				{form.kind === "exec" && (
					<>
						<div className="row">
							<label className="inline">
								<input type="radio" checked={form.execMode === "shell"} onChange={() => set("execMode", "shell")} />{" "}
								shell command
							</label>
							<label className="inline">
								<input type="radio" checked={form.execMode === "argv"} onChange={() => set("execMode", "argv")} /> argv
							</label>
						</div>
						{text("command", form.execMode === "shell" ? "Shell command" : "Command line (split into argv)", {
							mono: true,
						})}
						{text("cwd", "Working directory (optional)")}
						{text("stdin", "Stdin (optional)", { area: true })}
					</>
				)}
				{isFile && text("path", "Path", { mono: true })}
				{form.kind === "file.read" && (
					<div className="row">
						{text("offset", "Offset")}
						{text("limit", "Limit")}
					</div>
				)}
				{form.kind === "file.list" && text("limit", "Limit")}
				{form.kind === "file.write" && (
					<>
						{text("content", "Content", { area: true })}
						<label className="inline">
							<input type="checkbox" checked={form.overwrite} onChange={(e) => set("overwrite", e.target.checked)} />{" "}
							overwrite if exists
						</label>
					</>
				)}
				{form.kind === "file.edit" && (
					<>
						{text("oldText", "Old text", { area: true })}
						{text("newText", "New text", { area: true })}
					</>
				)}
				<ErrorText error={error} />
				<div className="row">
					<button type="submit" className="primary" disabled={running}>
						Run
					</button>
					{running && task && (
						<button
							type="button"
							className="danger"
							disabled={cancel.busy}
							onClick={() => cancel.run(() => api.cancelTask(task.id))}
						>
							Cancel
						</button>
					)}
				</div>
				<ErrorText error={cancel.error} />
			</form>
			{task && <TaskResult task={task} />}
		</section>
	);
}
