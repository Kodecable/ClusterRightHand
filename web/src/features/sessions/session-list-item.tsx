import type { SessionListItem } from "@crh/api";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { LoaderCircleIcon } from "lucide-react";
import { SessionStatusDot, StatusDot } from "@/components/status-badge";
import { displaySessionTitle } from "@/lib/session-title";
import { cn } from "@/lib/utils";
import { sessionIndicator, sessionIndicatorLabel } from "./session-indicator";
import { SessionMarkers } from "./session-markers";

/**
 * One row of the session list (doc/design/webui.md "Sidebar list"): only the title, on one line, and one leading
 * indicator: the yellow dot while the tree or a background job waits for the user, the spinner while it runs,
 * the blue dot for unread output. A read idle row has no indicator, but its title keeps the slot so every title
 * starts at the same place. Grey "Scheduled" / "Shared" badges sit at the right end of the line, and the
 * indicator's reason is the row's tooltip; the owner name and the relative time are dropped from the row.
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
	const { i18n } = useLingui();
	const title = displaySessionTitle(item.title, i18n);
	const indicator = sessionIndicator(item);
	const reason = indicator === null ? undefined : sessionIndicatorLabel(indicator.reason, item.waitingKind);
	const tooltip = reason === undefined ? undefined : i18n._(reason);

	// The extra height is the gap between rows. It sits outside the link so a
	// selected row is an inset rounded rectangle, like the sidebar's active item.
	// Virtua measures the content box of this wrapper, so a gap made of padding
	// or margin would be lost and the rows would overlap.
	return (
		<div className="flex h-10 min-w-0 items-center">
			<Link
				to="/sessions/$sessionId"
				params={{ sessionId: item.id }}
				data-testid="session-item"
				data-session-id={item.id}
				data-selected={selected ? "true" : "false"}
				data-state={item.state}
				data-waiting-kind={item.waitingKind ?? undefined}
				data-unread={item.unread ? "true" : "false"}
				data-indicator={indicator?.kind ?? "none"}
				data-indicator-reason={indicator?.reason}
				aria-current={selected ? "page" : undefined}
				title={tooltip}
				tabIndex={tabIndex}
				className={cn(
					"mx-2 flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-accent/70 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
					selected && "bg-accent",
				)}
			>
				{/* The indicator's slot is always there, so an idle row's title lines up with a running one's. */}
				<span className="inline-flex w-3 shrink-0 justify-center" data-testid="session-status-dot">
					{indicator?.kind === "attention" ? (
						<SessionStatusDot state="awaiting" />
					) : indicator?.kind === "busy" ? (
						<LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" role="img" aria-label={tooltip} />
					) : indicator?.kind === "unread" ? (
						<StatusDot tone="info" label={tooltip} />
					) : null}
					{indicator?.kind === "attention" && tooltip !== undefined && <span className="sr-only">{tooltip}</span>}
				</span>
				<span className="min-w-0 flex-1 truncate text-sm">{title}</span>
				<SessionMarkers scheduled={item.scheduleId !== null} shared={item.shared} sharedBy={item.ownerName} />
			</Link>
		</div>
	);
}
