import { api } from "../api.ts";
import { Loading } from "../components/Feedback.tsx";
import { useLoad, usePolling } from "../hooks.ts";
import { GroupResult } from "./Batch.tsx";

/** One task group from a link, e.g. a group that waits for the owner's signature. */
export function TaskGroupPage({ id }: { id: string }) {
	const { data, error, loading, reload } = useLoad(() => api.getTaskGroup(id), [id]);
	const nodes = useLoad(() => api.listNodes(), []);
	// A waiting or running group changes state elsewhere.
	usePolling(() => {
		if (data?.state === "awaiting_approval" || data?.state === "awaiting_authorization" || data?.state === "running") {
			reload();
		}
	}, 3000);
	const names = new Map((nodes.data ?? []).map((n) => [n.id, n.name]));
	return (
		<>
			<p>
				<a href="#/tasks">← Tasks</a>
			</p>
			<h1>Task group</h1>
			<Loading loading={loading && !data} error={error} />
			{data && <GroupResult group={data} names={names} onChanged={reload} />}
		</>
	);
}
