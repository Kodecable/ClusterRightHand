/**
 * The tasks page's URL filters (doc/webui.md "任务页与任务组页"): `node` opens the
 * list pre-filtered to one node, `user` to the tasks one user asked for. Both
 * are plain strings; anything else in the search string is ignored.
 */
export interface TasksSearch {
	node?: string;
	user?: string;
}

/** Keeps only the two filters the tasks page understands; empty and non-string values are dropped. */
export function parseTasksSearch(search: Record<string, unknown>): TasksSearch {
	const pick = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
	return { node: pick(search.node), user: pick(search.user) };
}
