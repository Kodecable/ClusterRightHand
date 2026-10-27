import type { TaskView } from "../api.ts";
import { Badge } from "../components/Feedback.tsx";
import { stateKind } from "../components/TaskResult.tsx";
import { useDirectory } from "../hooks.ts";
import { formatTime, taskActor, taskOutcome } from "../lib.ts";

export function TaskList({ tasks }: { tasks: TaskView[] }) {
	const { userName } = useDirectory();
	if (tasks.length === 0) return <p className="muted">No tasks yet.</p>;
	return (
		<div className="scroll-x">
			<table>
				<thead>
					<tr>
						<th>Created</th>
						<th>Task</th>
						<th>By</th>
						<th>State</th>
						<th>Outcome</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{tasks.map((t) => (
						<tr key={t.id}>
							<td>{formatTime(t.createdAt)}</td>
							<td>
								<span className="mono">{t.summary || t.kind}</span>
								{t.summary && <span className="muted"> ({t.kind})</span>}
							</td>
							<td>{taskActor(t, userName)}</td>
							<td>
								<Badge kind={stateKind(t)}>{t.state}</Badge>
							</td>
							<td>{taskOutcome(t)}</td>
							<td className="actions">
								<a href={`#/tasks/${t.id}`}>Details</a>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
