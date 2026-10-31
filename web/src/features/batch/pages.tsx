import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { PlayIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyHint } from "@/components/empty-state";
import { ErrorText } from "@/components/error-state";
import { NodePicker } from "@/components/node-picker";
import { PageSkeleton } from "@/components/skeletons";
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
import { TaskGroupResult } from "@/features/tasks/task-group-result";
import { buildTaskRequest, emptyForm, type TaskForm, taskFormErrorText } from "@/features/tasks/taskForm";

/**
 * A batch run (doc/webui.md "Batch"): pick nodes (or type groups and raw
 * targets), fill the shared task fields, run one task group and watch the
 * per-node grid fill in as the tasks finish. A group that waits for approval or
 * a signature shows the shared cards right above the grid.
 */
export function BatchPage() {
	const { t, i18n } = useLingui();
	const nodes = useNodes();
	const create = useCreateBatch();
	const [form, setForm] = useState<TaskForm>(emptyForm);
	const [picked, setPicked] = useState<string[]>([]);
	const [extra, setExtra] = useState("");
	const [parallel, setParallel] = useState("");
	const [failFast, setFailFast] = useState(false);
	const [outputMode, setOutputMode] = useState<"status" | "text">("status");
	const [groupId, setGroupId] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string>();
	const group = useTaskGroup(groupId, true);
	const names = new Map((nodes.data ?? []).map((node) => [node.id, node.name]));

	const operable = (nodes.data ?? []).filter((node) => node.status === "active" && node.access !== "view");
	const targets = buildTargets(picked, extra);

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
				outputMode,
				...(parsedParallel !== undefined ? { parallel: parsedParallel } : {}),
			});
			setGroupId(created.id);
			toast.success(t`Batch started.`);
		} catch (caught) {
			setError(taskFormErrorText(i18n, caught));
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4" data-testid="batch-page">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">
					<Trans>Batch run</Trans>
				</h1>
				<p className="text-sm text-muted-foreground">
					<Trans>Run one task on many nodes and follow each node's result.</Trans>
				</p>
			</div>

			<form
				className="grid gap-3 rounded-lg border p-3"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<fieldset className="grid gap-2">
					<legend className="text-sm font-semibold">
						<Trans>Targets</Trans>
					</legend>
					{nodes.isPending ? (
						<PageSkeleton rows={2} />
					) : (
						<NodePicker
							multiple
							nodes={operable}
							value={picked}
							onChange={setPicked}
							label={t`Nodes`}
							placeholder={t`Choose nodes`}
						/>
					)}
					{nodes.data && operable.length === 0 && <EmptyHint>{t`No active nodes you can operate.`}</EmptyHint>}
					<div className="grid gap-1.5">
						<Label htmlFor="batch-extra">
							<Trans>Groups or raw targets (comma separated, e.g. group:web, node-1)</Trans>
						</Label>
						<Input
							id="batch-extra"
							value={extra}
							onChange={(event) => setExtra(event.target.value)}
							placeholder="group:web, node-1"
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
				</div>

				<ErrorText error={error ?? create.error ?? nodes.error} />
				<div className="flex flex-wrap items-center gap-2">
					<Button type="submit" disabled={create.isPending || targets.length === 0} data-testid="batch-run">
						<PlayIcon />
						{targets.length === 0 ? (
							<Trans>Choose targets</Trans>
						) : (
							<Plural value={targets.length} one="Run on # target" other="Run on # targets" />
						)}
					</Button>
					<span className="text-xs text-muted-foreground">
						<Plural value={targets.length} one="# target" other="# targets" />
					</span>
				</div>
			</form>

			{group.error !== null && group.error !== undefined && <ErrorText error={group.error} />}
			{group.data !== undefined && (
				<div className="rounded-lg border p-3" data-testid="batch-result">
					<TaskGroupResult
						group={group.data}
						names={names}
						onChanged={() => {
							void group.refetch();
						}}
					/>
				</div>
			)}
		</div>
	);
}
