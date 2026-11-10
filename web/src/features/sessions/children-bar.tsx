import type { SessionChildrenSummary, SessionListItem } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { EmptyHint } from "@/components/empty-state";
import { ErrorText } from "@/components/error-state";
import { Spinner } from "@/components/spinner";
import { SessionStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { flattenCursorPages } from "@/lib/api/query";
import { cn, linkClass } from "@/lib/utils";
import { type SessionChildrenQuery, useSessionTreeChildren } from "./api";
import { sessionTitle } from "./session-item";

/**
 * The subagent strip directly above the composer (doc/design/webui.md "Subagent bar"): one compact line with the direct
 * child counts, which opens the subagent tree. A level is paged by `GET /sessions/:id/children`; a nested level
 * is fetched only when it is expanded, and every level has its own "load more". The line is hidden when the
 * session has no children, and the counts come from `GET /sessions/:id/children/summary`, so the line never
 * loads every page just to count.
 */
export function ChildrenBar({
	query,
	summary,
}: {
	query: SessionChildrenQuery;
	summary: SessionChildrenSummary | undefined;
}) {
	const { t } = useLingui();
	const [open, setOpen] = useState(false);
	const isMobile = useIsMobile();
	const items = flattenCursorPages(query.data);
	const total = summary?.total ?? items.length;
	if (total === 0) return null;
	const running = summary?.states.running ?? items.filter((item) => item.state === "running").length;
	const awaiting = summary?.states.awaiting ?? items.filter((item) => item.state === "awaiting").length;
	const close = () => setOpen(false);

	const trigger = (
		<Button
			type="button"
			variant="ghost"
			size="xs"
			className="w-full justify-start gap-1.5 rounded-xl px-3 py-1.5 text-xs font-normal text-muted-foreground hover:bg-accent/50"
			data-testid="children-bar"
			aria-label={t`Subagents`}
			aria-expanded={open}
		>
			<UsersIcon className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="inline-flex min-w-0 items-center gap-1.5">
				<Plural value={total} one="# subagent" other="# subagents" />
				{running > 0 && <Trans>{running} running</Trans>}
				{awaiting > 0 && <Trans>{awaiting} awaiting</Trans>}
			</span>
		</Button>
	);

	const tree = (
		<div className="min-h-0 overflow-y-auto" data-testid="children-tree">
			<ul className="grid gap-0.5">
				{items.map((item) => (
					<ChildNode key={item.id} item={item} depth={0} onNavigate={close} />
				))}
			</ul>
			{query.hasNextPage && (
				<LoadMore pending={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} className="ml-5" />
			)}
		</div>
	);

	if (isMobile) {
		return (
			<>
				<div className="mx-3 mb-0 rounded-xl bg-popover/80 backdrop-blur">{trigger}</div>
				<Sheet open={open} onOpenChange={setOpen}>
					<SheetContent side="bottom" className="max-h-[70vh]" data-testid="children-sheet">
						<SheetHeader>
							<SheetTitle>
								<Trans>Subagents</Trans>
							</SheetTitle>
						</SheetHeader>
						<div className="min-h-0 overflow-y-auto px-3 pb-3">{tree}</div>
					</SheetContent>
				</Sheet>
			</>
		);
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<div className="mx-3 mb-0 rounded-xl bg-popover/80 backdrop-blur" data-testid="children-bar-shell">
				<PopoverTrigger render={trigger} />
			</div>
			<PopoverContent
				side="top"
				align="start"
				className="max-h-80 w-96 overflow-y-auto p-2"
				data-testid="children-popover"
			>
				<p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
					<Trans>Subagents</Trans>
				</p>
				{tree}
			</PopoverContent>
		</Popover>
	);
}

/**
 * One node of the tree: its state, its title and a lazy toggle for its own
 * children. The title's stretched `after` covers the whole row, so the row is
 * one link, while the expand button stays above it.
 */
function ChildNode({ item, depth, onNavigate }: { item: SessionListItem; depth: number; onNavigate: () => void }) {
	const { t } = useLingui();
	const [expanded, setExpanded] = useState(false);
	return (
		<li>
			<div className="relative flex min-w-0 items-center gap-1" style={{ paddingLeft: `${depth * 12}px` }}>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className="relative z-10"
					aria-label={expanded ? t`Collapse subagents` : t`Expand subagents`}
					aria-expanded={expanded}
					data-testid="children-expand"
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
				</Button>
				<SessionStatusBadge state={item.state} className="shrink-0" />
				<Link
					to="/sessions/$sessionId"
					params={{ sessionId: item.id }}
					data-testid="child-session"
					data-session-id={item.id}
					data-state={item.state}
					data-waiting-kind={item.waitingKind ?? undefined}
					className={cn(
						"min-w-0 flex-1 truncate text-sm after:absolute after:inset-0 after:rounded-sm",
						linkClass,
						"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
					)}
					onClick={onNavigate}
				>
					{sessionTitle(item, t`New Session`)}
				</Link>
			</div>
			{expanded && <NestedChildren parentId={item.id} depth={depth + 1} onNavigate={onNavigate} />}
		</li>
	);
}

/** A node's own children, fetched only when the node is expanded. */
function NestedChildren({ parentId, depth, onNavigate }: { parentId: string; depth: number; onNavigate: () => void }) {
	const query = useSessionTreeChildren(parentId, true);
	const items = flattenCursorPages(query.data);
	if (query.isPending) {
		return (
			<div className="py-1 pl-6">
				<Spinner className="size-4" />
			</div>
		);
	}
	if (query.isError) {
		return <ErrorText error={query.error} className="py-1 pl-6 text-xs" />;
	}
	if (items.length === 0) {
		return (
			<EmptyHint className="py-1 pl-6 text-xs">
				<Trans>No subagents</Trans>
			</EmptyHint>
		);
	}
	return (
		<ul className="grid gap-0.5">
			{items.map((item) => (
				<ChildNode key={item.id} item={item} depth={depth} onNavigate={onNavigate} />
			))}
			{query.hasNextPage && (
				<LoadMore pending={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} className="ml-6" />
			)}
		</ul>
	);
}

/** One level's next page; the cursor is opaque, so this is the only way to see more of a level. */
function LoadMore({ pending, onClick, className }: { pending: boolean; onClick: () => void; className?: string }) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="xs"
			className={cn("justify-start text-xs text-muted-foreground", className)}
			disabled={pending}
			data-testid="children-load-more"
			onClick={onClick}
		>
			{pending && <Spinner className="size-3.5" decorative />}
			<Trans>Load more</Trans>
		</Button>
	);
}
