import type { NodeMetrics as NodeMetricsSample } from "@crh/api";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { formatDateTimeSeconds, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The tone of a usage bar: amber from 60 %, red from 80 %, green below (doc/design/webui.md "Node pages"). */
export function usageTone(percent: number): "ok" | "warn" | "danger" {
	if (percent >= 80) return "danger";
	if (percent >= 60) return "warn";
	return "ok";
}

const TONE_CLASS = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger" } as const;

/**
 * One usage bar and its percentage, coloured by the same thresholds everywhere (doc/design/webui.md
 * "Node pages"): the node list's CPU and memory figures and the Metrics summary cards share it. The
 * default "sm" size is the compact one of the node list, table and cards; the summary uses "md" so its
 * bar and percentage match the size of the uptime and traffic values beside them; the node card uses
 * "fill", whose bar takes the width left over by the labelled row.
 */
export function UsageBar({ ratio, size = "sm" }: { ratio: number; size?: "sm" | "md" | "fill" }) {
	const { i18n } = useLingui();
	const percent = Math.max(0, Math.min(1, ratio)) * 100;
	const tone = usageTone(percent);
	return (
		<span className={cn("flex items-center gap-1.5", size === "fill" && "w-full")} data-tone={tone} data-size={size}>
			<span
				className={cn(
					"overflow-hidden rounded-full bg-muted",
					size === "md" ? "h-2 w-24" : size === "fill" ? "h-1.5 min-w-0 flex-1" : "h-1.5 w-14",
				)}
				aria-hidden="true"
			>
				<span className={cn("block h-full rounded-full", TONE_CLASS[tone])} style={{ width: `${percent}%` }} />
			</span>
			<span
				className={cn(
					"shrink-0 text-right tabular-nums",
					size === "md" ? "text-sm font-medium leading-none" : "w-8 text-[11px] leading-none",
				)}
			>
				{formatNumber(percent, i18n.locale, { maximumFractionDigits: 0 })}%
			</span>
		</span>
	);
}

/** One labelled figure: a small label, a usage bar and its percentage. */
function UsageRow({ label, ratio }: { label: string; ratio: number }) {
	return (
		<span className="flex items-center gap-1.5">
			<span className="w-7 shrink-0 text-[10px] leading-none text-muted-foreground uppercase">{label}</span>
			<UsageBar ratio={ratio} />
		</span>
	);
}

/**
 * The node list's compact CPU and memory figures from the latest sample (doc/design/webui.md "Node
 * pages"): nothing when the node has no sample, and dimmed when the sample is older than three collection
 * intervals. The hover text names the exact percentages and when the sample was taken.
 */
export function NodeUsage({ metrics }: { metrics: NodeMetricsSample | undefined }) {
	const { i18n } = useLingui();
	if (!metrics || (metrics.cpu === undefined && metrics.memUsed === undefined)) return null;
	const parts: string[] = [];
	if (metrics.cpu !== undefined) {
		parts.push(`${i18n._(msg`CPU`)} ${formatNumber(metrics.cpu * 100, i18n.locale, { maximumFractionDigits: 0 })}%`);
	}
	if (metrics.memUsed !== undefined) {
		parts.push(
			`${i18n._(msg`Memory`)} ${formatNumber(metrics.memUsed * 100, i18n.locale, { maximumFractionDigits: 0 })}%`,
		);
	}
	return (
		<span
			className={cn("grid gap-1", metrics.stale && "opacity-50")}
			title={`${parts.join(" · ")} · ${formatDateTimeSeconds(metrics.at, i18n.locale)}`}
			data-testid="node-metrics-figures"
			data-stale={metrics.stale || undefined}
		>
			{metrics.cpu !== undefined && <UsageRow label={i18n._(msg`CPU`)} ratio={metrics.cpu} />}
			{metrics.memUsed !== undefined && <UsageRow label={i18n._(msg`Mem`)} ratio={metrics.memUsed} />}
		</span>
	);
}
