import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, type TaskView } from "../api.ts";
import { ErrorText } from "../components/Feedback.tsx";
import { TaskFormFields } from "../components/TaskFormFields.tsx";
import { TaskResult } from "../components/TaskResult.tsx";
import { errMsg, useAction } from "../hooks.ts";
import { isTerminal } from "../lib.ts";
import { buildTaskRequest, emptyForm, type TaskForm } from "../taskForm.ts";

export function RunPanel({ nodeId, onDone }: { nodeId: string; onDone: () => void }) {
	const [form, setForm] = useState<TaskForm>(emptyForm);
	const [task, setTask] = useState<TaskView>();
	const [error, setError] = useState<string>();
	const cancel = useAction();
	const abort = useRef<AbortController>(undefined);
	const running = task !== undefined && !isTerminal(task.state);
	useEffect(() => () => abort.current?.abort(), []);

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

	return (
		<section>
			<h2>Run</h2>
			<form onSubmit={submit} className="stack">
				<TaskFormFields form={form} onChange={setForm} />
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
