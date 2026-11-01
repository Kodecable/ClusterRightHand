import { Trans } from "@lingui/react/macro";
import { TriangleAlertIcon } from "lucide-react";

/** The clock-skew warning the node lists and the node page show beside the status. */
export function ClockWarning({ warning }: { warning: string | null }) {
	if (warning === null) return null;
	return (
		<span className="inline-flex items-center gap-1 text-xs text-warn" title={warning}>
			<TriangleAlertIcon className="size-3.5" aria-hidden="true" />
			<Trans>clock</Trans>
		</span>
	);
}
