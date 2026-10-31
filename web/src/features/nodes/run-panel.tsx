import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorText } from "@/components/error-state";
import { Spinner } from "@/components/spinner";
import { TaskFormFields } from "@/components/task-form-fields";
import { TaskResult } from "@/components/task-result";
import { Button } from "@/components/ui/button";
import { nodeKeys } from "@/features/nodes/api";
import { useCancelTask, useCreateTask, useTask } from "@/features/tasks/api";
import { isTerminal } from "@/features/tasks/output";
import { buildTaskRequest, emptyForm, type TaskForm, taskFormErrorText } from "@/features/tasks/taskForm";

/**
 * "Run a task on this node" (doc/webui.md "TaskFormFields" / "TaskResult"): the
 * shared task fields, the created task's result, and a cancel button while it
 * runs. The task is polled through Query until it reaches a terminal state.
 */
export function RunPanel({ nodeId }: { nodeId: string }) {
	const { t, i18n } = useLingui();
	const queryClient = useQueryClient();
	const create = useCreateTask(nodeId);
	const [form, setForm] = useState<TaskForm>(emptyForm);
	const [taskId, setTaskId] = useState<string>();
	const [formError, setFormError] = useState<string>();
	const task = useTask(taskId, true);
	const cancel = useCancelTask(taskId ?? "");
	const running = task.data !== undefined && !isTerminal(task.data.state);

	// The node's "Recent tasks" list is stale once a run reached a terminal
	// state; the task page's own cache is fine.
	useEffect(() => {
		if (task.data === undefined || !isTerminal(task.data.state)) return;
		void queryClient.invalidateQueries({ queryKey: nodeKeys.tasks(nodeId) });
	}, [nodeId, queryClient, task.data]);

	const submit = () => {
		setFormError(undefined);
		let body: ReturnType<typeof buildTaskRequest>;
		try {
			body = buildTaskRequest(form);
		} catch (error) {
			setFormError(taskFormErrorText(i18n, error));
			return;
		}
		create.mutate(body, {
			onSuccess: (created) => setTaskId(created.id),
			onError: (error) => setFormError(error.message),
		});
	};

	return (
		<section className="grid gap-3" aria-labelledby="node-run-heading" data-testid="run-panel">
			<h2 id="node-run-heading" className="text-sm font-semibold">
				<Trans>Run a task</Trans>
			</h2>
			<form
				className="grid gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<TaskFormFields form={form} onChange={setForm} disabled={create.isPending} />
				<ErrorText error={formError ?? create.error} />
				<div className="flex flex-wrap items-center gap-2">
					<Button type="submit" disabled={create.isPending}>
						{create.isPending && <Spinner className="size-4" decorative />}
						<Trans>Run</Trans>
					</Button>
					{running && taskId !== undefined && (
						<Button
							type="button"
							variant="destructive"
							disabled={cancel.isPending}
							onClick={() =>
								cancel.mutate(undefined, {
									onSuccess: () => toast.success(t`Task cancelled.`),
									onError: (error) => toast.error(error.message),
								})
							}
						>
							<Trans>Cancel task</Trans>
						</Button>
					)}
				</div>
				<ErrorText error={cancel.error} />
			</form>
			{task.isError && <ErrorText error={task.error} />}
			{task.data && <TaskResult task={task.data} />}
			{taskId !== undefined && task.isLoading && <Spinner />}
		</section>
	);
}
