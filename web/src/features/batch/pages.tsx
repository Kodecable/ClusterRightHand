import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { PlayIcon } from "lucide-react";
import { useState } from "react";
import { type EntityOption, EntityPicker } from "@/components/entity-picker";
import { ErrorText } from "@/components/error-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Panel, SectionTitle } from "@/components/section";
import { TaskFormFields } from "@/components/task-form-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateBatch } from "@/features/batch/api";
import { buildTargets } from "@/features/batch/targets";
import { useNodes } from "@/features/nodes/api";
import { useTaskGroup } from "@/features/tasks/api";
import { TaskGroupResult, TaskGroupSkippedNotice, TaskGroupStatus } from "@/features/tasks/task-group-result";
import { buildTaskRequest, emptyForm, type TaskForm, taskFormErrorText } from "@/features/tasks/taskForm";

/**
 * A batch run (doc/webui.md "Batch"): pick nodes, node groups or "All my
 * nodes", fill the shared task fields, run one task group and watch the
 * per-node grid fill in as the tasks finish.  A task group that waits for approval or
 * a signature shows the shared cards right above the grid.
 */
export function BatchPage() {
	const { t, i18n } = useLingui();
	const nodes = useNodes();
	const create = useCreateBatch();
	const [form, setForm] = useState<TaskForm>(emptyForm);
	const [picked, setPicked] = useState<string[]>([]);
	const [pickedNames, setPickedNames] = useState<Record<string, string>>({});
	const [pickedNodeGroups, setPickedNodeGroups] = useState<string[]>([]);
	const [pickedGroupNames, setPickedGroupNames] = useState<Record<string, string>>({});
	const [all, setAll] = useState(false);
	const [extra, setExtra] = useState("");
	const [parallel, setParallel] = useState("");
	const [failFast, setFailFast] = useState(false);
	const [outputMode, setOutputMode] = useState<"status" | "text">("status");
	const [taskGroupId, setTaskGroupId] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string>();
	const taskGroup = useTaskGroup(taskGroupId, true);
	// The result grid names every node it ran on, including node-group members the pickers never listed.
	const names = new Map((nodes.data ?? []).map((node) => [node.id, node.name]));

	// The pickers name their options; keeping the selected names here means the page never needs the
	// whole node and node-group lists just to submit targets by name (doc/webui.md "实体搜索").
	const pickNodes = (ids: string[], options: EntityOption[]) => {
		setPicked(ids);
		setPickedNames(Object.fromEntries(options.map((option) => [option.id, option.primary])));
	};
	const pickNodeGroups = (ids: string[], options: EntityOption[]) => {
		setPickedNodeGroups(ids);
		setPickedGroupNames(Object.fromEntries(options.map((option) => [option.id, option.primary])));
	};
	const targets = buildTargets({
		nodes: picked.map((id) => pickedNames[id] ?? id),
		nodeGroups: pickedNodeGroups.map((id) => pickedGroupNames[id] ?? id),
		all,
		extra,
	});

	const submit = async () => {
		setError(undefined);
		try {
			const request = buildTaskRequest(form);
			if (targets.length === 0) {
				setError(t`Choose at least one target.`);
				return;
			}
			const parsedParallel = parallel.trim() === "" ? undefined : Number(parallel);
			if (parsedParallel !== undefined && (!Number.isSafeInteger(parsedParallel) || parsedParallel < 1)) {
				setError(t`Parallel must be a positive whole number.`);
				return;
			}
			const created = await create.mutateAsync({
				...request,
				targets,
				failFast,
				// Only exec batches choose how much output to keep; a file operation always keeps the head.
				...(form.kind === "exec" ? { outputMode } : {}),
				...(parsedParallel !== undefined ? { parallel: parsedParallel } : {}),
			});
			setTaskGroupId(created.id);
		} catch (caught) {
			setError(taskFormErrorText(i18n, caught));
		}
	};

	return (
		<Page width="detail" data-testid="batch-page">
			<PageHeader title={<Trans>Batch run</Trans>} />

			<form
				className="grid gap-3 rounded-lg border p-4"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<fieldset className="grid gap-2">
					<legend className="text-sm font-medium">
						<Trans>Targets</Trans>
					</legend>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<span className="text-sm font-medium">{t`Nodes`}</span>
							<EntityPicker
								kind="node"
								multiple
								label={t`Nodes`}
								value={picked}
								onChange={pickNodes}
								disabled={all}
								includeDisabled={false}
							/>
						</div>
						<div className="grid gap-1.5">
							<span className="text-sm font-medium">{t`Node groups`}</span>
							<EntityPicker
								kind="nodeGroup"
								multiple
								label={t`Node groups`}
								value={pickedNodeGroups}
								onChange={pickNodeGroups}
								disabled={all}
							/>
						</div>
					</div>
					<div className="flex items-start gap-2">
						<Checkbox
							id="batch-all"
							checked={all}
							onCheckedChange={(checked) => setAll(Boolean(checked))}
							aria-describedby="batch-all-description"
						/>
						<div className="grid gap-0.5">
							<Label htmlFor="batch-all">
								<Trans>All accessible nodes</Trans>
							</Label>
							<p id="batch-all-description" className="text-xs text-muted-foreground">
								<Trans>Every node you can access, including nodes added later.</Trans>
							</p>
						</div>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="batch-extra">
							<Trans>Other targets (comma separated node or node-group names)</Trans>
						</Label>
						<Input
							id="batch-extra"
							value={extra}
							disabled={all}
							onChange={(event) => setExtra(event.target.value)}
							placeholder="node-1, web"
						/>
					</div>
				</fieldset>

				<TaskFormFields form={form} onChange={setForm} />

				<div className="flex flex-wrap items-end gap-3">
					<div className="grid gap-1.5">
						<Label htmlFor="batch-parallel">
							<Trans>Parallel</Trans>
						</Label>
						<Input
							id="batch-parallel"
							inputMode="numeric"
							value={parallel}
							className="w-24"
							placeholder="10"
							onChange={(event) => setParallel(event.target.value)}
						/>
					</div>
					<label className="flex items-center gap-2 pb-2 text-sm" htmlFor="batch-fail-fast">
						<Checkbox
							id="batch-fail-fast"
							checked={failFast}
							onCheckedChange={(checked) => setFailFast(Boolean(checked))}
						/>
						<Trans>Fail fast</Trans>
					</label>
					{form.kind === "exec" && (
						<div className="grid gap-1.5">
							<Label htmlFor="batch-output">
								<Trans>Output</Trans>
							</Label>
							<Select
								value={outputMode}
								onValueChange={(next) => {
									if (next === "status" || next === "text") setOutputMode(next);
								}}
							>
								<SelectTrigger id="batch-output" className="w-40">
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

				<ErrorText error={error ?? create.error ?? nodes.error} />
				<div className="flex flex-wrap items-center gap-2">
					<Button type="submit" disabled={create.isPending || targets.length === 0} data-testid="batch-run">
						<PlayIcon />
						{targets.length === 0 ? (
							<Trans>Choose targets</Trans>
						) : all ? (
							<Trans>Run on all accessible nodes</Trans>
						) : (
							<Plural value={targets.length} one="Run on # target" other="Run on # targets" />
						)}
					</Button>
					{!all && (
						<span className="text-xs text-muted-foreground">
							<Plural value={targets.length} one="# target" other="# targets" />
						</span>
					)}
				</div>
			</form>

			{taskGroup.error !== null && taskGroup.error !== undefined && <ErrorText error={taskGroup.error} />}
			{taskGroup.data !== undefined && (
				<Panel className="grid gap-3" data-testid="batch-result">
					<div className="flex flex-wrap items-center gap-2">
						<SectionTitle>
							<Trans>Result</Trans>
						</SectionTitle>
						<TaskGroupStatus state={taskGroup.data.state} />
					</div>
					<TaskGroupSkippedNotice taskGroup={taskGroup.data} names={names} />
					<TaskGroupResult
						taskGroup={taskGroup.data}
						names={names}
						onChanged={() => {
							void taskGroup.refetch();
						}}
					/>
				</Panel>
			)}
		</Page>
	);
}
