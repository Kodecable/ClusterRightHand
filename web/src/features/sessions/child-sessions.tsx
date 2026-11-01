import { createContext, type ReactNode, useContext } from "react";
import type { SessionListItem } from "@/lib/api/types";

/**
 * Publishes the session's direct children to the transcript (doc/webui.md#子会话栏): a `subagent` tool card
 * shows the child's live state, which the page already loads for the children bar, instead of the state the call
 * had when it returned. Outside a session page the list is empty and the card falls back to its own status.
 */

const SessionChildrenContext = createContext<readonly SessionListItem[]>([]);

export function SessionChildrenProvider({
	items,
	children,
}: {
	items: readonly SessionListItem[];
	children: ReactNode;
}) {
	return <SessionChildrenContext.Provider value={items}>{children}</SessionChildrenContext.Provider>;
}

/** The child session of `id` with its own state, as the page's children query has it now. */
export function useSessionChild(id: string | undefined): SessionListItem | undefined {
	const items = useContext(SessionChildrenContext);
	return id === undefined ? undefined : items.find((item) => item.id === id);
}
