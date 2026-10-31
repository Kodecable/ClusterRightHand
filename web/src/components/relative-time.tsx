import { useEffect, useState } from "react";
import { type DateInput, formatDateTime, formatDateTimeSeconds, formatRelativeTime } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function toIso(value: DateInput): string | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * "3 minutes ago", refreshed while mounted. The exact timestamp sits in the
 * tooltip and in `title`, so hovering always answers "when exactly?".
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
	return (
		<time
			dateTime={iso}
			title={iso ? formatDateTimeSeconds(iso, locale) : undefined}
			className={cn("text-muted-foreground tabular-nums", className)}
		>
			{formatRelativeTime(value, locale)}
		</time>
	);
}

/** An absolute date/time, with seconds for logs and audits. */
export function DateTime({
	value,
	seconds = false,
	className,
}: {
	value: DateInput;
	seconds?: boolean;
	className?: string;
}) {
	const { locale } = useLocale();
	const iso = toIso(value);
	return (
		<time dateTime={iso} className={cn("tabular-nums", className)}>
			{seconds ? formatDateTimeSeconds(value, locale) : formatDateTime(value, locale)}
		</time>
	);
}
