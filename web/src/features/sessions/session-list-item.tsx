import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CalendarClockIcon, Share2Icon } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { SessionStatusDot } from "@/components/status-badge";
import type { SessionListItem } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { sessionTitle, waitingKindLabel } from "./session-item";

/**
 * One row of the session list: status dot (with the wait as a tooltip), title,
 * relative time, and the scheduled / shared markers (doc/webui.md "侧边列表").
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
	const detail = wait === undefined ? undefined : i18n._(wait);
	const icons = (
		<>
			{item.scheduleId !== null && (
				<CalendarClockIcon className="size-3.5 shrink-0" aria-label={t`Scheduled session`} role="img" />
			)}
			{item.shared && <Share2Icon className="size-3.5 shrink-0" aria-label={t`Shared with you`} role="img" />}
		</>
	);

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
			tabIndex={tabIndex}
			className={cn(
				"flex min-w-0 items-start gap-2.5 border-b border-border/60 px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/70 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
				selected && "bg-accent",
			)}
		>
			<span className="mt-1.5 inline-flex shrink-0" title={detail} data-testid="session-status-dot">
				<SessionStatusDot state={item.state} />
				{detail !== undefined && <span className="sr-only">{detail}</span>}
			</span>
			<span className="grid min-w-0 flex-1 gap-0.5">
				<span className="truncate text-sm font-medium">{title}</span>
				<span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
					{!item.shared && item.ownerName !== "" && (
						<span className="truncate" data-testid="session-owner">
							{item.ownerName}
						</span>
					)}
					<RelativeTime value={item.updatedAt} className="shrink-0" />
					<span className="ml-auto flex shrink-0 items-center gap-1">{icons}</span>
				</span>
			</span>
		</Link>
	);
}
