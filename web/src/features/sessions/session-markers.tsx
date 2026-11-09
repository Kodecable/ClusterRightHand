import { useLingui } from "@lingui/react/macro";
import { CalendarClockIcon, Share2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
				<Badge variant="secondary" title={t`Scheduled session`}>
					<CalendarClockIcon aria-hidden="true" />
					{t`Scheduled`}
				</Badge>
			)}
			{shared && (
				<Badge variant="secondary" title={sharedBy ? t`Shared with you by ${sharedBy}` : t`Shared with you`}>
					<Share2Icon aria-hidden="true" />
					{t`Shared`}
				</Badge>
			)}
		</span>
	);
}
