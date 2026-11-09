import { useEffect, useState } from "react";
import { type DateInput, formatDateTimeSeconds, formatRelativeTime } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The typography of an absolute timestamp: tabular digits, so a column of
 * timestamps lines up. The font size comes from the surrounding cell, which is
 * why `time-column.ts` measures with the cell's size class plus this one.
 */
export const DATE_TIME_CLASS = "tabular-nums";

function toIso(value: DateInput): string | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * "3 minutes ago", refreshed while mounted. The exact timestamp (with seconds)
 * sits in `title`, so hovering always answers "when exactly?". The text keeps
 * the surrounding size and colour; only the digits are tabular.
 */
export function RelativeTime({
	value,
	className,
	refreshMs = 30_000,
}: {
	value: DateInput;
	className?: string;
	refreshMs?: number;
}) {
	const { locale } = useLocale();
	const [, setTick] = useState(0);

	useEffect(() => {
		if (refreshMs <= 0) return;
		const timer = setInterval(() => setTick((tick) => tick + 1), refreshMs);
		return () => clearInterval(timer);
	}, [refreshMs]);

	const iso = toIso(value);
	// A missing time keeps the placeholder muted, like every other empty value.
	if (iso === undefined) return <span className={cn("text-muted-foreground", className)}>–</span>;
	return (
		<time dateTime={iso} title={formatDateTimeSeconds(iso, locale)} className={cn(DATE_TIME_CLASS, className)}>
			{formatRelativeTime(value, locale)}
		</time>
	);
}

/** The one absolute date/time format: date and time with seconds, locale-aware. */
export function DateTime({ value, className }: { value: DateInput; className?: string }) {
	const { locale } = useLocale();
	const iso = toIso(value);
	if (iso === undefined) return <span className={cn("text-muted-foreground", className)}>–</span>;
	return (
		<time dateTime={iso} className={cn(DATE_TIME_CLASS, className)}>
			{formatDateTimeSeconds(value, locale)}
		</time>
	);
}
