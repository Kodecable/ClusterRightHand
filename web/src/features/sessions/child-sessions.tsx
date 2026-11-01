import { Plural, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";
import { RelativeTime } from "@/components/relative-time";
import { SessionStatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { flattenCursorPages } from "@/lib/api/query";
import type { SessionListItem } from "@/lib/api/types";
import type { useSessionChildren } from "./api";
import { sessionTitle } from "./session-item";

/** The session's children, newest activity first, as `GET /sessions/:id/children` lists them. */
export type SessionChildrenQuery = ReturnType<typeof useSessionChildren>;

const SessionChildrenContext = createContext<readonly SessionListItem[]>([]);

/**
 * Publishes the session's children to the transcript (doc/webui.md#会话界面): a `subagent` tool card shows
 * the child's live state, which the page already loads for the strip above it, instead of the state the call
 * had when it returned. Outside a session page the list is empty and the card falls back to its own status.
 */
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

function ChildRow({ item }: { item: SessionListItem }) {
	const { t } = useLingui();
	return (
		<Link
			to="/sessions/$sessionId"
			params={{ sessionId: item.id }}
			data-testid="child-session"
			data-session-id={item.id}
			data-state={item.state}
			data-waiting-kind={item.waitingKind ?? undefined}
			className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent"
		>
			<SessionStatusDot state={item.state} />
			<span className="min-w-0 truncate">{sessionTitle(item, t`Untitled session`)}</span>
			<RelativeTime value={item.updatedAt} className="shrink-0 text-muted-foreground" />
		</Link>
	);
}

/**
 * The session's direct subagent sessions (`GET /sessions/:id/children`),
 * newest activity first, with each child's own state (doc/webui.md#api-约定).
 * The complete list is paged by cursor; the page hook refetches it after the
 * events that can add or change a child.
 */
export function ChildSessions({ query }: { query: SessionChildrenQuery }) {
	const { t } = useLingui();
	const items = flattenCursorPages(query.data);
	if (items.length === 0) return null;
	return (
		<section
			data-testid="child-sessions"
			aria-label={t`Subagent sessions`}
			className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1 text-xs"
		>
			<span className="text-muted-foreground">
				<Plural value={items.length} one="Subagent session" other="Subagent sessions" />:
			</span>
			{items.map((item) => (
				<ChildRow key={item.id} item={item} />
			))}
			{query.hasNextPage && (
				<Button
					type="button"
					variant="ghost"
					size="xs"
					disabled={query.isFetchingNextPage}
					onClick={() => void query.fetchNextPage()}
				>
					{t`Load more`}
				</Button>
			)}
		</section>
	);
}
