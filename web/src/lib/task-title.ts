/**
 * The one title of a task or task group (doc/design/webui.md "Task and task group pages"): the action the
 * server built (the command, the file operation with its path, …), or the kind when a row has no readable
 * action. Every place that names a task or task group — page headers, the shell title, table cells and
 * links — uses this, so they never disagree.
 */
import type { TaskAction } from "@crh/api";
import type { I18n } from "@lingui/core";
import { actionText } from "@/lib/action-text";

export function taskTitle(i18n: I18n, task: { action?: TaskAction | null; summary: string; kind: string }): string {
	return task.action ? actionText(i18n, task.action) : task.summary || task.kind;
}
