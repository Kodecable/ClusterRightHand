import type { NodeMetricsWarning, PublicNode } from "@crh/api";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowUpIcon, TriangleAlertIcon } from "lucide-react";
import { formatDateTimeSeconds } from "@/lib/format";
import { WarningIndicator, WarningList } from "./trust-warnings";

/**
 * The two notices the node list shows beside the status, besides the trust warning
 * (doc/design/webui.md "Node pages"): metrics collection currently failing, and a crha that is older
 * than crhs's own release. The metrics notice is only sent for an online node, so an offline node says
 * only that it is offline.
 */
export function NodeWarningsIndicator({ node }: { node: Pick<PublicNode, "metricsWarning" | "updateAvailable"> }) {
	const { t, i18n } = useLingui();
	const metricsWarning = node.metricsWarning;
	if (metricsWarning === null && !node.updateAvailable) return null;
	return (
		<span className="inline-flex items-center gap-1.5">
			{metricsWarning !== null && (
				<WarningIndicator
					tone="warn"
					testId="metrics-warning-indicator"
					title={`${i18n._(msg`Metrics collection failing`)}: ${metricsWarning.reason}`}
				>
					<TriangleAlertIcon className="size-3.5" aria-hidden="true" />
					<Trans>Metrics</Trans>
				</WarningIndicator>
			)}
			{node.updateAvailable && (
				<WarningIndicator tone="info" testId="update-available-indicator" title={t`Update available`}>
					<ArrowUpIcon className="size-3.5" aria-hidden="true" />
					<Trans>Update available</Trans>
				</WarningIndicator>
			)}
		</span>
	);
}

/**
 * The details of a failing metrics collection on the node page (doc/design/webui.md "Node pages"):
 * what failed and since when. The reason is crhs's own text, kept untranslated for diagnosis.
 */
export function MetricsWarningList({ warning }: { warning: NodeMetricsWarning | null }) {
	const { t, i18n } = useLingui();
	return (
		<WarningList
			label={t`Metrics collection failing`}
			testId="metrics-warning"
			items={
				warning === null
					? []
					: [
							{
								key: "metrics",
								severity: "warning",
								title: warning.reason,
								content: (
									<span className="grid gap-0.5">
										<span className="font-medium">
											<Trans>Metrics collection failing</Trans>
										</span>
										<span>{warning.reason}</span>
										<span className="text-xs text-muted-foreground">
											<Trans>Since {formatDateTimeSeconds(warning.since, i18n.locale)}</Trans>
										</span>
									</span>
								),
							},
						]
			}
		/>
	);
}

/** The generic "update available" notice, for the node page's header beside the upgrade action. */
export function UpdateAvailableBadge() {
	const { t } = useLingui();
	return (
		<WarningIndicator tone="info" testId="update-available" title={t`A newer crha is available for this node.`}>
			<ArrowUpIcon className="size-3.5" aria-hidden="true" />
			<Trans>Update available</Trans>
		</WarningIndicator>
	);
}
