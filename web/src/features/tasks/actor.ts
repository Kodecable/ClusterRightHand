import type { TaskView } from "@/lib/api/types";

/** Who asked for a task, as the list and the task page show it. */
export interface TaskActor {
	/** The name to display: a directory name when known, else the raw actor. */
	name: string;
	/** The raw id, kept for a tooltip or a secondary line. */
	id: string;
}

/**
 * The task's origin: the user it acted for (resolved via the directory), else
 * the user that asked, else the non-user actor (an agent, a token, a schedule).
 */
export function taskActor(task: TaskView, userName: (id: string) => string | undefined): TaskActor {
	if (task.onBehalfOfUserId !== null) {
		return { name: userName(task.onBehalfOfUserId) ?? task.onBehalfOfUserId, id: task.onBehalfOfUserId };
	}
	if (task.actorType === "user") {
		return { name: userName(task.actorId) ?? task.actorId, id: task.actorId };
	}
	return { name: `${task.actorType} ${task.actorId}`, id: task.actorId };
}
