import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { FormDialog } from "@/components/dialogs";
import { type EntityOption, EntityPicker } from "@/components/entity-picker";
import { FieldShell } from "@/components/form";
import { TaskFormFields } from "@/components/task-form-fields";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ALL_TARGET } from "@/lib/names";
import { useCreateTask, useCreateTaskGroup } from "./api";
import { buildTaskRequest, emptyForm, type TaskForm, taskFormErrorText } from "./taskForm";

/**
 * The "Run task" dialog of the tasks page (doc/design/webui.md "Task and task group pages"): pick nodes or node
 * groups, fill the shared task fields and create either one task (exactly one node) or a task
 * group (anything else). It only submits: success closes it and opens the new task or group.
 */
export function RunTaskDialog({ onClose }: { onClose: () => void }) {
	const { t, i18n } = useLingui();
	const navigate = useNavigate();
	const [selected, setSelected] = useState<EntityOption[]>([]);
	const [all, setAll] = useState(false);
	const [form, setForm] = useState<TaskForm>(emptyForm);
	const [parallel, setParallel] = useState("");
	const [failFast, setFailFast] = useState(false);
	const [outputMode, setOutputMode] = useState<"status" | "text">("status");
	const [error, setError] = useState<string>();

	// A single picked node is one task; a node group, two or more targets and "all" are a group.
	const singleNode = !all && selected.length === 1 && selected[0]?.kind === "node" ? selected[0] : undefined;
	const createTask = useCreateTask(singleNode?.id ?? "");
	const createGroup = useCreateTaskGroup();
	const busy = createTask.isPending || createGroup.isPending;

	const submit = async () => {
		setError(undefined);
		let request: ReturnType<typeof buildTaskRequest>;
		try {
			request = buildTaskRequest(form);
		} catch (caught) {
			setError(taskFormErrorText(i18n, caught));
			return;
		}
		const targets = all ? [ALL_TARGET] : selected.map((option) => option.primary);
		if (targets.length === 0) {
			setError(t`Choose at least one target.`);
			return;
		}
		const parsedParallel = parallel.trim() === "" ? undefined : Number(parallel);
		if (parsedParallel !== undefined && (!Number.isSafeInteger(parsedParallel) || parsedParallel < 1)) {
			setError(t`Parallel must be a positive whole number.`);
			return;
		}
		try {
			if (singleNode !== undefined) {
				const created = await createTask.mutateAsync(request);
				onClose();
				await navigate({ to: "/tasks/$taskId", params: { taskId: created.id } });
				return;
			}
			const created = await createGroup.mutateAsync({
				...request,
				targets,
				failFast,
				// Only exec groups choose how much output to keep; a file operation always keeps the head.
				...(form.kind === "exec" ? { outputMode } : {}),
				...(parsedParallel !== undefined ? { parallel: parsedParallel } : {}),
			});
			onClose();
			await navigate({ to: "/task-groups/$taskGroupId", params: { taskGroupId: created.id } });
		} catch (caught) {
			setError(taskFormErrorText(i18n, caught));
		}
	};

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Run task</Trans>}
			submitLabel={<Trans>Run</Trans>}
			busy={busy}
			error={error}
			onSubmit={() => void submit()}
			testId="run-task-dialog"
		>
			<FieldShell id="run-task-targets" label={t`Nodes or node groups`}>
				<EntityPicker
					id="run-task-targets"
					kind="nodeTarget"
					multiple
					label={t`Nodes or node groups`}
					value={selected.map((option) => option.id)}
					onChange={(_ids, options) => setSelected(options)}
					disabled={all || busy}
					className="w-full"
				/>
			</FieldShell>
			<div className="flex items-center gap-2">
				<Checkbox
					id="run-task-all"
					checked={all}
					disabled={busy}
					onCheckedChange={(checked) => setAll(Boolean(checked))}
				/>
				<Label htmlFor="run-task-all">
					<Trans>All nodes I can access</Trans>
				</Label>
			</div>

			<TaskFormFields form={form} onChange={setForm} disabled={busy} />

			<details className="rounded-lg border p-3" data-testid="run-task-more-options">
				<summary className="cursor-pointer text-sm font-medium">
					<Trans>More options</Trans>
				</summary>
				<div className="mt-3 flex flex-wrap items-end gap-3">
					<div className="grid gap-1.5">
						<Label htmlFor="run-task-parallel">
							<Trans>Parallel</Trans>
						</Label>
						<Input
							id="run-task-parallel"
							inputMode="numeric"
							value={parallel}
							disabled={busy}
							className="w-24"
							placeholder="10"
							onChange={(event) => setParallel(event.target.value)}
						/>
					</div>
					<label className="flex items-center gap-2 pb-2 text-sm" htmlFor="run-task-fail-fast">
						<Checkbox
							id="run-task-fail-fast"
							checked={failFast}
							disabled={busy}
							onCheckedChange={(checked) => setFailFast(Boolean(checked))}
						/>
						<Trans>Fail fast</Trans>
					</label>
					{form.kind === "exec" && (
						<div className="grid gap-1.5">
							<Label htmlFor="run-task-output">
								<Trans>Output</Trans>
							</Label>
							<Select
								value={outputMode}
								onValueChange={(next) => {
									if (next === "status" || next === "text") setOutputMode(next);
								}}
								disabled={busy}
							>
								<SelectTrigger id="run-task-output" className="w-40">
									<SelectValue>
										{(current: string | null) =>
											current === "text" ? <Trans>Tail of output</Trans> : <Trans>Status only</Trans>
										}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="status">
										<Trans>Status only</Trans>
									</SelectItem>
									<SelectItem value="text">
										<Trans>Tail of output</Trans>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					)}
				</div>
			</details>
		</FormDialog>
	);
}
