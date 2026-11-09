import type { SessionListItem } from "@crh/api";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { subscribeSse } from "@/lib/api/sse";
import { type SessionListData, sessionKeys } from "./api";
import {
	isSessionListItem,
	removeSessionListItem,
	type SessionListFilter,
	sessionListFilter,
	upsertSessionListItem,
} from "./list-patch";
import { publishSessionListUpsert } from "./list-stream-bus";

export interface SessionStreamOptions {
	/** Current user id and admin flag: the filter needs them to patch `scope` lists. */
	viewer: { id: string; isAdmin: boolean };
	enabled?: boolean;
}

/**
 * Subscribes to `GET /api/sessions/stream` and patches every loaded session
 * list in the Query cache. The stream is scoped to `visible`, like the list
 * itself, so an administrator's stream carries no session they cannot see in
 * the list. The list is only patched while it has a first page; an unloaded
 * list fetches the row with its first page anyway.
 *
 * On a reconnect the contract asks for a fresh first page: the query is
 * invalidated, which refetches the loaded pages (the simpler correct choice;
 * the buffer that a page-at-a-time refresh would need does not exist yet).
 */
export function useSessionListStream({ viewer, enabled = true }: SessionStreamOptions): void {
	const queryClient = useQueryClient();
	const { id: viewerId, isAdmin } = viewer;

	useEffect(() => {
		if (!enabled) return;
		const patchLists = (
			update: (pages: NonNullable<SessionListData["pages"]>, filter: SessionListFilter) => SessionListData["pages"],
		) => {
			for (const query of queryClient.getQueryCache().findAll({ queryKey: sessionKeys.list() })) {
				const filter = sessionListFilter(query.queryKey, { viewerId, isAdmin });
				if (!filter) continue;
				queryClient.setQueryData<SessionListData>(query.queryKey, (data) => {
					if (!data) return data;
					const pages = update(data.pages, filter);
					if (pages === data.pages) return data;
					return { ...data, pages };
				});
			}
		};

		return subscribeSse({
			url: "/api/sessions/stream?scope=visible",
			events: ["upsert", "remove"],
			onEvent: (event, data) => {
				if (event === "upsert") {
					if (!isSessionListItem(data)) return;
					const item: SessionListItem = data;
					patchLists((pages, filter) => upsertSessionListItem(pages, item, filter));
					publishSessionListUpsert(item);
				} else if (event === "remove") {
					if (data === null || typeof data !== "object") return;
					const id = (data as { id?: unknown }).id;
					if (typeof id !== "string" || id === "") return;
					patchLists((pages) => removeSessionListItem(pages, id));
				}
			},
			onOpen: (reconnected) => {
				if (!reconnected) return;
				void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
			},
		});
	}, [queryClient, enabled, viewerId, isAdmin]);
}
