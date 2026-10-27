import { api } from "../api.ts";
import { Loading } from "../components/Feedback.tsx";
import { TaskResult } from "../components/TaskResult.tsx";
import { useLoad, usePolling } from "../hooks.ts";

export function TaskPage({ id }: { id: string }) {
	const { data, error, loading, reload } = useLoad(() => api.getTask(id), [id]);
	// A task waiting for approval changes state elsewhere.
	usePolling(() => {
		if (data?.state === "awaiting_approval") reload();
	}, 3000);
	return (
		<>
			<p>
				<a href={data ? `#/nodes/${data.nodeId}` : "#/nodes"}>← Node</a>
			</p>
			<h1>Task</h1>
			<Loading loading={loading} error={error} />
			{data && <TaskResult task={data} />}
		</>
	);
}
