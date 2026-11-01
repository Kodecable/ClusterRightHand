import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { SessionStatusDot } from "@/components/status-badge";
import type { SessionListItem } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { sessionTitle, waitingKindLabel } from "./session-item";
import { SessionMarkers } from "./session-markers";

/**
 * One row of the session list (doc/webui.md#侧边列表): only the title, on one line, and a status dot for the
 * two states that need attention (running, awaiting). An idle row has no dot, but its title keeps the dot's slot
 * so every title starts at the same place. Grey "Scheduled" / "Shared" badges sit at the right end of the line,
 * and the wait is the row's tooltip; the owner name and the relative time are dropped from the row.
 */
export function SessionListItemRow({
	item,
	selected,
	tabIndex,
}: {
	item: SessionListItem;
	selected: boolean;
	/** Roving tabindex: only the active row is reachable with Tab; arrows move it. */
	tabIndex: number;
}) {
	const { t, i18n } = useLingui();
	const wait = waitingKindLabel(item.waitingKind);
	const title = sessionTitle(item, t`Untitled session`);
	const dot = item.state === "running" || item.state === "awaiting";
	const tooltip = wait === undefined ? undefined : i18n._(wait);

	return (
		<Link
			to="/sessions/$sessionId"
			params={{ sessionId: item.id }}
			data-testid="session-item"
			data-session-id={item.id}
			data-selected={selected ? "true" : "false"}
			data-state={item.state}
			data-waiting-kind={item.waitingKind ?? undefined}
			aria-current={selected ? "page" : undefined}
			title={tooltip}
			tabIndex={tabIndex}
			className={cn(
				"flex h-9 min-w-0 items-center gap-2 border-b border-border/60 px-3 text-left outline-none transition-colors hover:bg-accent/70 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
				selected && "bg-accent",
			)}
		>
			{/* The dot's slot is always there, so an idle row's title lines up with a running one's. */}
			<span className="inline-flex w-2 shrink-0 justify-center" data-testid="session-status-dot">
				{dot && <SessionStatusDot state={item.state} />}
				{wait !== undefined && <span className="sr-only">{i18n._(wait)}</span>}
			</span>
			<span className="min-w-0 flex-1 truncate text-sm">{title}</span>
			<SessionMarkers scheduled={item.scheduleId !== null} shared={item.shared} sharedBy={item.ownerName} />
		</Link>
	);
}
