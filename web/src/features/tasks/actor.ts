import type { TaskView } from "@crh/api";

/** Who asked for a task, as the list and the task page show it. */
export interface TaskActor {
	/** The name to display: a directory name when known, else the raw actor. */
	name: string;
	/** The raw id, kept for a tooltip or a secondary line. */
	id: string;
}

/**
 * The task's origin: the user it acted for (resolved via the directory). The
 * server always sends `onBehalfOfUserId` (a task that a token, a schedule or
 * an agent started still acted for a user).
 */
export function taskActor(task: TaskView, userName: (id: string) => string | undefined): TaskActor {
	return { name: userName(task.onBehalfOfUserId) ?? task.onBehalfOfUserId, id: task.onBehalfOfUserId };
}
