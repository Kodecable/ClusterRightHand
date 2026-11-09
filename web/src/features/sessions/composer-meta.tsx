import type { SessionView } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { DatabaseIcon, GaugeIcon } from "lucide-react";
import { useModels } from "@/features/settings/api";
import { formatNumber, formatTokens } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { cacheHitPercent, formatLatency, formatTokenRate } from "./generation-stat-format";

/**
 * The session's generation line under the composer box: its own turns, steps
 * and speed, then its tree's usage and cache hit, then the context fill of the
 * last main call (doc/agent-runtime.md "会话统计", doc/webui.md "输入框"). The
 * line wraps on a narrow screen and every number keeps its exact value in a
 * tooltip.
 */
export function ComposerMeta({ session }: { session: SessionView }) {
	return (
		<div
			data-testid="composer-meta"
			className="mt-1.5 flex min-w-0 flex-wrap items-center justify-center gap-x-2 text-xs text-muted-foreground"
		>
			<ActivityControl session={session} />
			<UsageControl session={session} />
			<ContextControl session={session} />
		</div>
	);
}

/**
 * Turns and steps of this session, with the decode rate when timing is known;
 * nothing at all before the first step. The tooltip adds the average TTFT.
 */
function ActivityControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const { turns, steps, ttftMs, ttftSteps, decodeMs, decodeTokens } = session.stats;
	if (steps === 0) return null;
	const rate = decodeMs > 0 ? decodeTokens / (decodeMs / 1_000) : null;
	const averageTtft = ttftSteps > 0 ? ttftMs / ttftSteps : null;
	const title = [
		averageTtft === null ? null : t`Average time to first token: ${formatLatency(averageTtft, locale)}`,
		rate === null ? null : t`Decode speed: ${formatTokenRate(rate, locale)} tok/s`,
	]
		.filter((part): part is string => part !== null)
		.join(" · ");
	return (
		<span
			data-testid="composer-activity"
			{...(title === "" ? {} : { title })}
			className="inline-flex shrink-0 items-center gap-1 px-1.5 whitespace-nowrap"
		>
			<GaugeIcon className="size-3.5" aria-hidden="true" />
			<span>
				<Plural value={turns} one="# turn" other="# turns" /> <Plural value={steps} one="# step" other="# steps" />
				{rate !== null && (
					<>
						{" · "}
						<Trans>{formatTokenRate(rate, locale)} tok/s</Trans>
					</>
				)}
			</span>
		</span>
	);
}

/** The context fill of the last main call as a ring and a percentage; hidden until both are known. */
function ContextControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const models = useModels();
	const used = session.contextTokens;
	const model = models.data?.find(
		(candidate) => candidate.provider === session.model.provider && candidate.modelId === session.model.modelId,
	);
	if (used === null || model === undefined || model.contextWindow <= 0) return null;
	const ratio = used / model.contextWindow;
	const percent = Math.max(0, Math.round(ratio * 100));
	const title = `${formatNumber(used, locale)} / ${formatNumber(model.contextWindow, locale)}`;
	return (
		<span
			data-testid="composer-context"
			title={title}
			role="img"
			aria-label={t`Context: ${percent}% used`}
			className={cn("inline-flex shrink-0 items-center gap-1 px-1.5 whitespace-nowrap", ratio >= 0.9 && "text-warn")}
		>
			<ContextRing ratio={ratio} />
			{percent}%
		</span>
	);
}

/** A small ring that fills with the context; the percentage sits beside it. */
function ContextRing({ ratio }: { ratio: number }) {
	const radius = 5;
	const circumference = 2 * Math.PI * radius;
	const filled = circumference * Math.min(1, Math.max(0, ratio));
	return (
		<svg viewBox="0 0 14 14" aria-hidden="true" className="size-3.5 shrink-0 -rotate-90">
			<circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
			<circle
				cx="7"
				cy="7"
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeDasharray={`${filled} ${circumference - filled}`}
			/>
		</svg>
	);
}

/**
 * The total usage of the session tree, in auto units, then the cache hit when
 * the tree recorded any prompt tokens. Exact numbers are the tooltip.
 */
function UsageControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const exact = formatNumber(session.usageTokens, locale);
	const { promptTokens, cacheReadTokens } = session.stats;
	const hit = cacheHitPercent(cacheReadTokens, promptTokens);
	const title =
		hit === null
			? t`${exact} tokens in total`
			: t`${exact} tokens in total · Cache hit: ${formatNumber(cacheReadTokens, locale)} / ${formatNumber(promptTokens, locale)}`;
	return (
		<span
			data-testid="composer-usage"
			title={title}
			className="inline-flex shrink-0 items-center gap-1 px-1.5 whitespace-nowrap"
		>
			<DatabaseIcon className="size-3.5" aria-hidden="true" />
			<span>
				{formatTokens(session.usageTokens, locale)}
				{hit !== null && (
					<>
						{" · "}
						<Trans>{hit}%</Trans>
					</>
				)}
			</span>
		</span>
	);
}
