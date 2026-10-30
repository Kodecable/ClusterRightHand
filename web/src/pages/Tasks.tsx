import { useEffect, useState } from "react";
import { api, type TaskView } from "../api.ts";
import { ErrorText, Loading } from "../components/Feedback.tsx";
import { useAction, useLoad } from "../hooks.ts";
import { TaskList } from "./TaskList.tsx";

/** The states a task can be filtered by; the empty value is "any". */
const STATES = [
	"",
	"awaiting_approval",
	"awaiting_authorization",
	"dispatched",
	"running",
	"exited",
	"failed",
	"rejected",
	"unknown",
	"denied",
] as const;

/**
 * Every task the user can see, across nodes (doc/privilege.md: the task page in the top navigation).
 * The server puts the tasks that wait for this user first when no state is chosen.
 */
export function Tasks() {
	const nodes = useLoad(() => api.listNodes(), []);
	const [state, setState] = useState("");
	const [nodeId, setNodeId] = useState("");
	const filter = {
		...(state ? { state } : {}),
		...(nodeId ? { nodeId } : {}),
	};
	const first = useLoad(() => api.listTasks(filter), [state, nodeId]);
	const [more, setMore] = useState<TaskView[]>([]);
	const [nextOffset, setNextOffset] = useState<number | null>(null);
	const action = useAction();
	useEffect(() => {
		setMore([]);
		setNextOffset(first.data?.nextOffset ?? null);
	}, [first.data]);
	const tasks = [...(first.data?.tasks ?? []), ...more];
	const loadMore = async () => {
		if (nextOffset === null) return;
		const page = await action.run(() => api.listTasks({ ...filter, offset: nextOffset }));
		if (!page) return;
		setMore((m) => [...m, ...page.tasks]);
		setNextOffset(page.nextOffset);
	};
	return (
		<>
			<h1>Tasks</h1>
			<p className="muted">
				Every task on the nodes you can see, newest first; tasks waiting for your approval or signature come first.
			</p>
			<div className="row wrap">
				<label>
					State
					<select value={state} onChange={(e) => setState(e.target.value)}>
						{STATES.map((s) => (
							<option key={s} value={s}>
								{s || "any"}
							</option>
						))}
					</select>
				</label>
				<label>
					Node
					<select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
						<option value="">any</option>
						{(nodes.data ?? []).map((n) => (
							<option key={n.id} value={n.id}>
								{n.name}
							</option>
						))}
					</select>
				</label>
			</div>
			<ErrorText error={nodes.error} />
			<Loading loading={first.loading && !first.data} error={first.error} />
			{first.data && <TaskList tasks={tasks} />}
			<ErrorText error={action.error} />
			{nextOffset !== null && (
				<div className="row">
					<button type="button" onClick={loadMore} disabled={action.busy}>
						Load more
					</button>
				</div>
			)}
		</>
	);
}
