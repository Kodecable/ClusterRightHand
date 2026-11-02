import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

export interface CodeTextProps {
	text: string;
	/** Lines beyond this collapse; 0 disables collapsing. */
	maxLines?: number;
	className?: string;
	/** Extra classes for the `<pre>`; `max-h-none` lets a dialog body own the scroll. */
	preClassName?: string;
	/** Show the copy button in the corner (default: true). */
	copy?: boolean;
	/** An accessible label for the block, e.g. "Command output". */
	label?: string;
}

/**
 * Long monospace output: a scrollable `<pre>` that collapses after `maxLines`,
 * with a copy button (doc/webui.md "CodeText").
 */
export function CodeText({ text, maxLines = 24, className, preClassName, copy = true, label }: CodeTextProps) {
	const { t } = useLingui();
	const [expanded, setExpanded] = useState(false);
	const lines = useMemo(() => text.split("\n").length, [text]);
	const collapsible = maxLines > 0 && lines > maxLines;
	const visible = collapsible && !expanded ? text.split("\n").slice(0, maxLines).join("\n") : text;

	return (
		<section
			data-slot="code-text"
			aria-label={label}
			className={cn("group relative block rounded-lg border bg-[var(--code)]", className)}
		>
			{copy && (
				<div className="absolute top-1.5 right-1.5 z-10 opacity-60 transition-opacity group-hover:opacity-100">
					<CopyButton text={text} label={label ? `${label}: ${t`Copy`}` : undefined} />
				</div>
			)}
			<pre
				className={cn(
					"max-h-96 overflow-auto p-3 pr-9 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
					preClassName,
				)}
			>
				{visible}
			</pre>
			{collapsible && (
				<div className="flex items-center justify-between border-t px-2 py-1">
					<span className="text-xs text-muted-foreground">
						{expanded ? (
							<Plural value={lines} one="# line" other="# lines" />
						) : (
							<Trans>
								Showing first {maxLines} of {lines} lines
							</Trans>
						)}
					</span>
					<Button type="button" size="xs" variant="ghost" onClick={() => setExpanded((value) => !value)}>
						{expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
						{expanded ? <Trans>Show less</Trans> : <Trans>Show all</Trans>}
					</Button>
				</div>
			)}
		</section>
	);
}
