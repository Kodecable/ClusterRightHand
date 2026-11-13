import type { LibraryLimits, LibraryUsage } from "@crh/api";
import { useLingui } from "@lingui/react/macro";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A used/limit ratio; a limit of 0 allows nothing, so any use is over it. */
function ratio(used: number, limit: number): number {
	if (limit > 0) return used / limit;
	return used > 0 ? 1 : 0;
}

/**
 * The library's compact usage readout in the file toolbar (doc/design/webui.md "Library page"): the share
 * of the total size limit used and a bar for the tighter of the two limits, with the exact numbers in a tooltip. The
 * bar turns to the warning colour near a limit.
 */
export function LibraryUsageIndicator({ usage, limits }: { usage: LibraryUsage; limits: LibraryLimits }) {
	const { t, i18n } = useLingui();
	const filesRatio = ratio(usage.files, limits.files);
	const bytesRatio = ratio(usage.bytes, limits.totalBytes);
	const tightest = Math.max(filesRatio, bytesRatio);
	const warning = tightest >= 0.9;
	const percent = (value: number) => `${formatNumber(Math.round(value * 100), i18n.locale)}%`;

	const filesPercent = percent(filesRatio);
	const bytesPercent = percent(bytesRatio);
	const filesUsed = formatNumber(usage.files, i18n.locale);
	const filesLimit = formatNumber(limits.files, i18n.locale);
	const bytesUsed = formatBytes(usage.bytes, i18n.locale);
	const bytesLimit = formatBytes(limits.totalBytes, i18n.locale);

	return (
		<Tooltip>
			<TooltipTrigger
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the readout is a focus stop, so its tooltip is reachable by keyboard.
				render={<span className="flex items-center gap-2 rounded-md px-1.5 py-1 outline-none" tabIndex={0} />}
				data-testid="library-usage"
			>
				<span className={cn("text-xs tabular-nums whitespace-nowrap", warning ? "text-warn" : "text-muted-foreground")}>
					{bytesPercent}
				</span>
				<Progress
					value={Math.min(1, tightest) * 100}
					aria-label={t`Library usage`}
					className={cn("w-16", warning && "[&_[data-slot=progress-indicator]]:bg-warn")}
				/>
			</TooltipTrigger>
			<TooltipContent>
				<span className="grid gap-0.5">
					<span>{t`File count limit: ${filesPercent} (${filesUsed}/${filesLimit})`}</span>
					<span>{t`Total size limit: ${bytesPercent} (${bytesUsed}/${bytesLimit})`}</span>
				</span>
			</TooltipContent>
		</Tooltip>
	);
}
