/**
 * Query keys of the node-group endpoints. Kept apart from `api.ts` so that the
 * node hooks can invalidate the list without importing the node-group hooks
 * (which import the node hooks in turn).
 */
export const nodeGroupKeys = {
	all: ["node-groups"] as const,
	list: () => ["node-groups", "list"] as const,
};
