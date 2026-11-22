/** Reading a job's stored TaskAction, shared by the tools and the subagent renderer. */
import type { TaskAction } from "@crh/api";
import { summarizeAction } from "../cluster/action.ts";
import type { JobRow } from "./types.ts";

export function actionOf(job: Pick<JobRow, "action">): TaskAction | undefined {
	try {
		return JSON.parse(job.action) as TaskAction;
	} catch {
		return undefined;
	}
}

/** The action's one-line text: the command, the file path, the API route, the tool or the subagent task. */
export function actionText(job: Pick<JobRow, "action">): string {
	const action = actionOf(job);
	return action === undefined ? "" : summarizeAction(action);
}
