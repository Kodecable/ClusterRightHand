import type { ReactNode } from "react";
import { KINDS, type Kind, type TaskForm } from "../taskForm.ts";

/** The task fields shared by the node Run panel and the batch page; `extra` renders beside Kind and Timeout. */
export function TaskFormFields({
	form,
	onChange,
	extra,
}: {
	form: TaskForm;
	onChange: (f: TaskForm) => void;
	extra?: ReactNode;
}) {
	const set = <K extends keyof TaskForm>(k: K, v: TaskForm[K]) => onChange({ ...form, [k]: v });
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

	const isFile = form.kind !== "exec";
	return (
		<>
			<div className="row wrap">
				<label>
					Kind
					<select value={form.kind} onChange={(e) => set("kind", e.target.value as Kind)}>
						{KINDS.map((k) => (
							<option key={k}>{k}</option>
						))}
					</select>
				</label>
				{extra}
				<label>
					Timeout (s)
					<input
						value={form.timeoutSec}
						inputMode="numeric"
						size={6}
						onChange={(e) => set("timeoutSec", e.target.value)}
					/>
				</label>
				<label
					className="inline"
					title="Run with elevated privileges according to the node's privileged mode; SSH nodes ignore it and run as the SSH user"
				>
					<input type="checkbox" checked={form.privileged} onChange={(e) => set("privileged", e.target.checked)} />{" "}
					Privileged
				</label>
			</div>
			{form.kind === "exec" && (
				<>
					<div className="row">
						<label className="inline">
							<input type="radio" checked={form.execMode === "shell"} onChange={() => set("execMode", "shell")} /> shell
							command
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
		</>
	);
}
