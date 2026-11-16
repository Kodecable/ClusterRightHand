import { CopyButton } from "@/components/copy-button";
import { cn, MONO_CELL } from "@/lib/utils";

/**
 * An id shown in full with its copy button, for detail facts. The id wraps on a narrow screen instead of
 * overflowing its column (a flex item would otherwise keep the id's whole width), and the button keeps its
 * size beside it.
 */
export function CopyableId({ id, copyLabel, className }: { id: string; copyLabel: string; className?: string }) {
	return (
		<span className={cn("flex min-w-0 items-center gap-1", className)}>
			<code className={cn(MONO_CELL, "min-w-0 [overflow-wrap:anywhere]")}>{id}</code>
			<CopyButton text={id} label={copyLabel} variant="ghost" size="icon-xs" className="shrink-0" />
		</span>
	);
}
