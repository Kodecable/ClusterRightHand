import { useLingui } from "@lingui/react/macro";
import { DatabaseIcon } from "lucide-react";
import { useModels } from "@/features/settings/api";
import type { SessionView } from "@/lib/api/types";
import { formatNumber, formatTokens } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The session's own context fill and its tree's total usage, on a line of their
 * own under the composer box so the footer's model, rules and budget always fit.
 * The context ring is the last main call; the database icon is the usage of the
 * whole tree (doc/agent-runtime.md#会话状态).
 */
export function ComposerMeta({ session }: { session: SessionView }) {
	return (
		<div
			data-testid="composer-meta"
			className="mt-1.5 flex min-w-0 flex-wrap items-center justify-center gap-x-2 text-xs text-muted-foreground"
		>
			<ContextControl session={session} />
			<UsageControl session={session} />
		</div>
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

/** The total usage of the session tree, in auto units; the exact number is the tooltip. */
function UsageControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const exact = formatNumber(session.usageTokens, locale);
	return (
		<span
			data-testid="composer-usage"
			title={t`${exact} tokens in total`}
			className="inline-flex shrink-0 items-center gap-1 px-1.5 whitespace-nowrap"
		>
			<DatabaseIcon className="size-3.5" aria-hidden="true" />
			{formatTokens(session.usageTokens, locale)}
		</span>
	);
}
