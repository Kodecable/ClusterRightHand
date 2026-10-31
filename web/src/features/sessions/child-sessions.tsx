import { Plural, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/relative-time";
import { SessionStatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { flattenCursorPages } from "@/lib/api/query";
import type { SessionListItem } from "@/lib/api/types";
import { useSessionChildren } from "./api";
import { sessionTitle } from "./session-item";

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
export function ChildSessions({
	sessionId,
	rootId,
	revision,
}: {
	sessionId: string;
	rootId: string | undefined;
	/** Bumped by the session's `snapshot` and by `subagent` tool updates and ends. */
	revision: number;
}) {
	const { t } = useLingui();
	const children = useSessionChildren(sessionId, rootId, revision);
	const items = flattenCursorPages(children.data);
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
			{children.hasNextPage && (
				<Button
					type="button"
					variant="ghost"
					size="xs"
					disabled={children.isFetchingNextPage}
					onClick={() => void children.fetchNextPage()}
				>
					{t`Load more`}
				</Button>
			)}
		</section>
	);
}
