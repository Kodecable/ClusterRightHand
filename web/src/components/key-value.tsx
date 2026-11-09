import type { ReactNode } from "react";
import { cn, MONO_CELL } from "@/lib/utils";

export interface KeyValueItem {
	label: ReactNode;
	value: ReactNode;
	/** Render the value in a monospace font (ids, commands, hashes). */
	mono?: boolean;
	/**
	 * The value is a control (Select, Button, Switch) rather than text: center
	 * the label against it instead of sharing a text baseline.
	 */
	control?: boolean;
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
				// Labels and values share a 20px line box (mono values too), so text of both sizes is centered on the same line
				// without the baseline shift that made mono rows taller; a control value opts into centering.
				"grid items-start gap-x-6 gap-y-2 text-sm",
				columns === 2 ? "grid-cols-1 sm:grid-cols-[auto_1fr_auto_1fr]" : "grid-cols-[max-content_1fr]",
				className,
			)}
		>
			{items.map((item, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: items are a static, ordered list of fields
				<div key={index} className="contents">
					<dt className={cn("text-muted-foreground", item.control && "self-center")}>{item.label}</dt>
					<dd
						className={cn(
							"min-w-0 break-words [overflow-wrap:anywhere]",
							item.mono && MONO_CELL,
							item.control && "self-center",
						)}
					>
						{item.value}
					</dd>
				</div>
			))}
		</dl>
	);
}
