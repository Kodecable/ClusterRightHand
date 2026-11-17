import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { CodeFrame } from "@/components/code-frame";
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
	/** Show the copy action in the frame header (default: true). */
	copy?: boolean;
	/** The frame header title and the block's accessible label, e.g. "Command output". */
	label?: string;
}

/**
 * Long monospace output: the shared code frame with a scrollable `<pre>` that collapses after
 * `maxLines`, a copy action in the header, and a footer with Show all / Show less
 * (doc/design/webui.md "Shared components").
 */
export function CodeText({ text, maxLines = 24, className, preClassName, copy = true, label }: CodeTextProps) {
	const { t } = useLingui();
	const [expanded, setExpanded] = useState(false);
	const lines = useMemo(() => text.split("\n").length, [text]);
	const collapsible = maxLines > 0 && lines > maxLines;
	const visible = collapsible && !expanded ? text.split("\n").slice(0, maxLines).join("\n") : text;

	return (
		<CodeFrame
			aria-label={label}
			title={label}
			actions={copy ? <CopyButton text={text} label={label ? t`Copy ${label}` : undefined} /> : undefined}
			className={className}
			bodyClassName={cn("max-h-96 overflow-auto", preClassName)}
			footer={
				collapsible ? (
					<>
						<span className="text-xs text-muted-foreground">
							{!expanded && (
								<Trans>
									Showing first {maxLines} of {lines} lines
								</Trans>
							)}
						</span>
						<Button type="button" size="xs" variant="ghost" onClick={() => setExpanded((value) => !value)}>
							{expanded ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
							{expanded ? <Trans>Show less</Trans> : <Trans>Show all</Trans>}
						</Button>
					</>
				) : undefined
			}
		>
			<pre
				className={cn(
					"min-w-0 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
					preClassName,
				)}
			>
				{visible}
			</pre>
		</CodeFrame>
	);
}
