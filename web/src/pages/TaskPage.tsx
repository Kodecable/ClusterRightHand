import { api } from "../api.ts";
import { Loading } from "../components/Feedback.tsx";
import { TaskResult } from "../components/TaskResult.tsx";
import { useLoad } from "../hooks.ts";

export function TaskPage({ id }: { id: string }) {
	const { data, error, loading } = useLoad(() => api.getTask(id), [id]);
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
