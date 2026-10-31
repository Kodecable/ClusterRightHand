import type { TaskView } from "@/lib/api/types";

/** The task's origin: the user it acted for (resolved via the directory), else the actor. */
export function taskActor(task: TaskView, userName: (id: string) => string | undefined): string {
	if (task.onBehalfOfUserId !== null) return userName(task.onBehalfOfUserId) ?? task.onBehalfOfUserId;
	return `${task.actorType} ${task.actorId}`;
}
