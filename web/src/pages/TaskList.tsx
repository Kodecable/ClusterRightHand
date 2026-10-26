import type { TaskView } from "../api.ts";
import { Badge } from "../components/Feedback.tsx";
import { stateKind } from "../components/TaskResult.tsx";
import { formatTime, taskOutcome } from "../lib.ts";

export function TaskList({ tasks }: { tasks: TaskView[] }) {
	if (tasks.length === 0) return <p className="muted">No tasks yet.</p>;
	return (
		<div className="scroll-x">
			<table>
				<thead>
					<tr>
						<th>Created</th>
						<th>Kind</th>
						<th>State</th>
						<th>Outcome</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{tasks.map((t) => (
						<tr key={t.id}>
							<td>{formatTime(t.createdAt)}</td>
							<td>{t.kind}</td>
							<td>
								<Badge kind={stateKind(t.state)}>{t.state}</Badge>
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
