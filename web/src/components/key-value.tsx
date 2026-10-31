import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface KeyValueItem {
	label: ReactNode;
	value: ReactNode;
	/** Render the value in a monospace font (ids, commands, hashes). */
	mono?: boolean;
}

/** A label/value list, the standard way to show a record's fields. */
export function KeyValueList({
	items,
	className,
	columns = 1,
}: {
	items: readonly KeyValueItem[];
	className?: string;
	columns?: 1 | 2;
}) {
	return (
		<dl
			data-slot="key-value"
			className={cn(
				"grid gap-x-6 gap-y-2 text-sm",
				columns === 2 ? "grid-cols-1 sm:grid-cols-[auto_1fr_auto_1fr]" : "grid-cols-[max-content_1fr]",
				className,
			)}
		>
			{items.map((item, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: items are a static, ordered list of fields
				<div key={index} className="contents">
					<dt className="text-muted-foreground">{item.label}</dt>
					<dd className={cn("min-w-0 break-words", item.mono && "font-mono text-xs")}>{item.value}</dd>
				</div>
			))}
		</dl>
	);
}
