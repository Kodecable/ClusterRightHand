import type { NodeTraffic } from "@crh/api";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { formatBytes } from "@/lib/format";
import { formatZonedDateTime } from "@/lib/timezone";

/**
 * The newest network rates of a node (doc/design/webui.md "Node pages"): received and sent, each after
 * its arrow. The value stays the plain byte count and only the accessible label says it is per second;
 * the Metrics summary card and the node card share this shape.
 */
export function LiveTraffic({
	rxBytesPerSec,
	txBytesPerSec,
}: {
	rxBytesPerSec: number | undefined;
	txBytesPerSec: number | undefined;
}) {
	const { i18n } = useLingui();
	if (rxBytesPerSec === undefined && txBytesPerSec === undefined) {
		return <span className="text-muted-foreground">–</span>;
	}
	const received = rxBytesPerSec === undefined ? "–" : formatBytes(rxBytesPerSec, i18n.locale);
	const sent = txBytesPerSec === undefined ? "–" : formatBytes(txBytesPerSec, i18n.locale);
	const receivedRate = `${received}/s`;
	const sentRate = `${sent}/s`;
	const label = i18n._(msg`Received ${receivedRate}, sent ${sentRate}`);
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			data-testid="live-traffic"
			className="inline-flex min-w-0 flex-wrap items-center gap-1 tabular-nums"
		>
			<ArrowDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
			<span>{received}</span>
			<span aria-hidden="true"> / </span>
			<ArrowUpIcon className="size-3.5 shrink-0" aria-hidden="true" />
			<span>{sent}</span>
		</span>
	);
}

/**
 * A node's traffic in the current 30-day period (doc/design/metrics.md "Traffic totals"): received and
 * transmitted bytes, with the period's start and the reset instant only in the tooltip. A node without a
 * traffic row shows "–".
 */
export function TotalTraffic({ traffic }: { traffic: NodeTraffic | null | undefined }) {
	const { i18n } = useLingui();
	if (traffic === null || traffic === undefined) return <span className="text-muted-foreground">–</span>;
	const title = `${i18n._(msg`Since ${formatZonedDateTime(traffic.periodStart, i18n.locale)}`)} · ${i18n._(
		msg`Next reset ${formatZonedDateTime(traffic.nextResetAt, i18n.locale)}`,
	)}`;
	return (
		<span
			role="img"
			aria-label={title}
			title={title}
			data-testid="total-traffic"
			className="inline-flex min-w-0 flex-wrap items-center gap-1 tabular-nums"
		>
			<ArrowDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
			<span>{formatBytes(traffic.rxBytes, i18n.locale)}</span>
			<span aria-hidden="true"> / </span>
			<ArrowUpIcon className="size-3.5 shrink-0" aria-hidden="true" />
			<span>{formatBytes(traffic.txBytes, i18n.locale)}</span>
		</span>
	);
}
