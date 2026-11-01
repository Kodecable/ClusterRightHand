import { useLingui } from "@lingui/react/macro";
import { CalendarClockIcon, Share2Icon } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

/**
 * The grey "Scheduled" and "Shared" badges (doc/webui.md#侧边列表, #页头): a session a schedule started, and a
 * session someone else shared with the viewer. The list row and the page header show the same badges.
 */
export function SessionMarkers({
	scheduled,
	shared,
	sharedBy,
	className,
}: {
	scheduled: boolean;
	shared: boolean;
	/** The owner's name, for the shared badge's tooltip. */
	sharedBy?: string | null;
	className?: string;
}) {
	const { t } = useLingui();
	if (!scheduled && !shared) return null;
	return (
		<span className={cn("flex shrink-0 items-center gap-1", className)} data-testid="session-markers">
			{scheduled && (
				<StatusBadge tone="muted" dot={false} title={t`Scheduled session`} className="gap-1 px-1 py-0 text-[11px]">
					<CalendarClockIcon className="size-3" aria-hidden="true" />
					{t`Scheduled`}
				</StatusBadge>
			)}
			{shared && (
				<StatusBadge
					tone="muted"
					dot={false}
					title={sharedBy ? t`Shared with you by ${sharedBy}` : t`Shared with you`}
					className="gap-1 px-1 py-0 text-[11px]"
				>
					<Share2Icon className="size-3" aria-hidden="true" />
					{t`Shared`}
				</StatusBadge>
			)}
		</span>
	);
}
