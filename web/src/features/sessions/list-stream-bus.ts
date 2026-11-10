import type { SessionListItem } from "@crh/api";

/**
 * The upserts of `GET /api/sessions/stream`, as a small broadcast for the rest
 * of the sessions feature.
 *
 * The list stream is opened once by the sessions layout; a session page still
 * needs to know when its tree's root was republished, because the child list
 * (`GET /api/sessions/:id/children`) has no stream of its own and the docs say
 * to refetch it on the root's `upsert` (doc/design/webui.md "API conventions"). Broadcasting the
 * parsed item is cheaper than opening a second `EventSource` per page.
 */
export type SessionListUpsertListener = (item: SessionListItem) => void;

const listeners = new Set<SessionListUpsertListener>();

/** Shares one validated upsert; returns a function that removes the listener. */
export function subscribeSessionListUpserts(listener: SessionListUpsertListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function publishSessionListUpsert(item: SessionListItem): void {
	for (const listener of [...listeners]) listener(item);
}
