import { api } from "../api.ts";
import { useUser } from "../auth.tsx";
import { AuthorizationWait } from "../components/AuthorizationWait.tsx";
import { Loading } from "../components/Feedback.tsx";
import { TaskResult } from "../components/TaskResult.tsx";
import { useLoad, usePolling } from "../hooks.ts";

export function TaskPage({ id }: { id: string }) {
	const user = useUser();
	const { data, error, loading, reload } = useLoad(() => api.getTask(id), [id]);
	// A task waiting for approval or authorization changes state elsewhere.
	usePolling(() => {
		if (data?.state === "awaiting_approval" || data?.state === "awaiting_authorization") reload();
	}, 3000);
	const owner = data?.onBehalfOfUserId === user.id;
	return (
		<>
			<p>
				<a href={data ? `#/nodes/${data.nodeId}` : "#/nodes"}>← Node</a>
			</p>
			<h1>Task</h1>
			<Loading loading={loading} error={error} />
			{data && data.state === "awaiting_authorization" && owner && (
				<AuthorizationWait kind="task" id={data.id} onChanged={reload} />
			)}
			{data && <TaskResult task={data} />}
		</>
	);
}
