import type { PublicNode } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { TriangleAlertIcon } from "lucide-react";
import { formatDuration } from "@/lib/format";

/** The wire shape of a clock warning: a measured offset, not the authorization's clock tolerance. */
export type NodeClockWarning = NonNullable<PublicNode["clockWarning"]>;

const AHEAD = msg`The node's clock is {duration} ahead of crhs (measured once when crha connects)`;
const BEHIND = msg`The node's clock is {duration} behind crhs (measured once when crha connects)`;

/**
 * The localized warning for a measured clock offset (doc/design/privilege.md "Clock"). The measurement
 * happens once, when crha connects, so the text names it; the threshold is not part of the text.
 */
export function clockWarningText(i18n: I18n, warning: NodeClockWarning): string {
	const descriptor = warning.offsetMs >= 0 ? AHEAD : BEHIND;
	return i18n._({ ...descriptor, values: { duration: formatDuration(Math.abs(warning.offsetMs), i18n.locale) } });
}

/** The clock warning the node lists and the node page show beside the status. */
export function ClockWarning({ warning }: { warning: NodeClockWarning | null }) {
	const { i18n } = useLingui();
	if (warning === null) return null;
	return (
		<span className="inline-flex items-center gap-1 text-xs text-warn" title={clockWarningText(i18n, warning)}>
			<TriangleAlertIcon className="size-3.5" aria-hidden="true" />
			<Trans>clock</Trans>
		</span>
	);
}
