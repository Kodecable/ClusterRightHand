/**
 * The one title of a task or task group (doc/webui.md "任务页与任务组页"): its
 * summary, or the kind when there is no summary. Every place that names a task
 * or task group — page headers, the shell title, table cells and links — uses
 * this, so they never disagree.
 */
export function taskTitle(task: { summary: string; kind: string }): string {
	return task.summary || task.kind;
}
