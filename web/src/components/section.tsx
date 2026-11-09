import type { ComponentProps, ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A bordered block of a detail page or form (doc/webui.md "卡片"): one radius,
 * one padding and one border everywhere, instead of a page-specific mix of
 * `p-3`, rings and the larger ui `Card`.
 */
export function Panel({
	as: Component = "div",
	className,
	...props
}: Omit<ComponentProps<"div">, "as"> & { as?: ElementType }) {
	return <Component data-slot="panel" className={cn("rounded-lg border p-4", className)} {...props} />;
}

/** The heading of a section: the one section-title style of the web UI. */
export function SectionTitle({ className, children, ...props }: ComponentProps<"h2">) {
	return (
		<h2 className={cn("text-sm font-medium", className)} {...props}>
			{children}
		</h2>
	);
}

/**
 * The header row of a table section (doc/webui.md "小节布局"): the section
 * title on the left and that section's actions on the right, above the table.
 * Actions never float below the table or below an empty state.
 */
export function SectionHeader({
	id,
	title,
	actions,
	className,
}: {
	/** The id the section's `aria-labelledby` names. */
	id?: string;
	title: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-wrap items-center justify-between gap-2", className)}>
			<SectionTitle id={id}>{title}</SectionTitle>
			{actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}
