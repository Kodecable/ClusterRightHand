import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { KINDS, type Kind, type TaskForm } from "@/lib/task-form";
import { cn } from "@/lib/utils";

function Field({
	id,
	label,
	children,
	className,
}: {
	id: string;
	label: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("grid gap-1.5", className)}>
			<Label htmlFor={id}>{label}</Label>
			{children}
		</div>
	);
}

/**
 * The task fields shared by the tasks page's "Run task" dialog and the rule
 * test panel: kind, mode, the kind's fields, timeout and the privileged flag.
 */
export function TaskFormFields({
	form,
	onChange,
	extra,
	disabled = false,
}: {
	form: TaskForm;
	onChange: (form: TaskForm) => void;
	extra?: ReactNode;
	disabled?: boolean;
}) {
	const { t } = useLingui();
	const prefix = useId();
	const id = (key: string) => `${prefix}-${key}`;
	const set = <K extends keyof TaskForm>(key: K, value: TaskForm[K]) => onChange({ ...form, [key]: value });

	const text = (key: keyof TaskForm, label: ReactNode, options: { area?: boolean; mono?: boolean } = {}) => (
		<Field id={id(key)} label={label}>
			{options.area ? (
				<Textarea
					id={id(key)}
					rows={4}
					className={options.mono ? "font-mono text-xs" : undefined}
					value={form[key] as string}
					disabled={disabled}
					onChange={(event) => set(key, event.target.value as never)}
				/>
			) : (
				<Input
					id={id(key)}
					className={options.mono ? "font-mono text-xs" : undefined}
					value={form[key] as string}
					disabled={disabled}
					onChange={(event) => set(key, event.target.value as never)}
				/>
			)}
		</Field>
	);

	return (
		<div className="grid gap-3" data-slot="task-form-fields">
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<Field id={id("kind")} label={t`Kind`}>
					<Select
						value={form.kind}
						onValueChange={(next) => {
							if (typeof next === "string") set("kind", next as Kind);
						}}
						disabled={disabled}
					>
						<SelectTrigger id={id("kind")} className="w-full">
							<SelectValue>{(current: string | null) => current ?? ""}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{KINDS.map((kind) => (
								<SelectItem key={kind} value={kind}>
									{kind}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				{extra}
				<Field id={id("timeoutSec")} label={t`Timeout (s)`}>
					<Input
						id={id("timeoutSec")}
						inputMode="numeric"
						value={form.timeoutSec}
						disabled={disabled}
						onChange={(event) => set("timeoutSec", event.target.value)}
					/>
				</Field>
				<div className="flex items-end pb-2">
					<div className="flex items-center gap-2">
						<Checkbox
							id={id("privileged")}
							checked={form.privileged}
							disabled={disabled}
							onCheckedChange={(checked) => set("privileged", Boolean(checked))}
						/>
						<Label htmlFor={id("privileged")}>{t`Privileged`}</Label>
					</div>
				</div>
			</div>

			{form.kind === "exec" && (
				<>
					<fieldset className="flex flex-wrap gap-4">
						<legend className="sr-only">
							<Trans>Command mode</Trans>
						</legend>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="radio"
								name={`${prefix}-mode`}
								checked={form.execMode === "shell"}
								disabled={disabled}
								onChange={() => set("execMode", "shell")}
							/>
							<Trans>Shell command</Trans>
						</label>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="radio"
								name={`${prefix}-mode`}
								checked={form.execMode === "argv"}
								disabled={disabled}
								onChange={() => set("execMode", "argv")}
							/>
							<Trans>argv</Trans>
						</label>
					</fieldset>
					{text("command", form.execMode === "shell" ? t`Shell command` : t`Command line (split into argv)`, {
						mono: true,
					})}
					{text("cwd", t`Working directory (optional)`)}
					{text("stdin", t`Stdin (optional)`, { area: true })}
				</>
			)}

			{form.kind !== "exec" && text("path", t`Path`, { mono: true })}
			{form.kind === "file.read" && (
				<div className="grid gap-3 sm:grid-cols-2">
					{text("offset", t`Start line`)}
					{text("limit", t`Lines`)}
				</div>
			)}
			{form.kind === "file.list" && text("limit", t`Limit`)}
			{form.kind === "file.write" && (
				<>
					{text("content", t`Content`, { area: true })}
					<div className="flex items-center gap-2">
						<Checkbox
							id={id("overwrite")}
							checked={form.overwrite}
							disabled={disabled}
							onCheckedChange={(checked) => set("overwrite", Boolean(checked))}
						/>
						<Label htmlFor={id("overwrite")}>{t`Overwrite if it exists`}</Label>
					</div>
				</>
			)}
			{form.kind === "file.edit" && (
				<>
					{text("oldText", t`Old text`, { area: true })}
					{text("newText", t`New text`, { area: true })}
				</>
			)}
		</div>
	);
}
