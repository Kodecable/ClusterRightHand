import { useLingui } from "@lingui/react/macro";
import { DATE_TIME_CLASS, RelativeTime } from "@/components/relative-time";
import { type DateInput, formatDateTimeSeconds } from "@/lib/format";
import { useLocale } from "@/lib/i18n";

/**
 * A node's "Last seen" value. `last_seen_at` is only written when crha
 * connects, says hello or disconnects, so a node that stays connected would
 * read "9 hours ago" while it is online right now. A connected client node
 * therefore shows "Now" (doc/webui.md "Nodes"), with the time it connected as
 * the hover title; a disconnected or SSH node keeps the relative time.
 */
export function NodeLastSeen({ lastSeenAt, connected }: { lastSeenAt: DateInput; connected: boolean | null }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	if (connected !== true) return <RelativeTime value={lastSeenAt} />;
	if (lastSeenAt === null || lastSeenAt === undefined || lastSeenAt === "") {
		return <span className={DATE_TIME_CLASS}>{t`Now`}</span>;
	}
	const date = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
	if (Number.isNaN(date.getTime())) return <span className={DATE_TIME_CLASS}>{t`Now`}</span>;
	const iso = date.toISOString();
	return (
		<time dateTime={iso} title={t`Connected since ${formatDateTimeSeconds(iso, locale)}`} className={DATE_TIME_CLASS}>
			{t`Now`}
		</time>
	);
}
