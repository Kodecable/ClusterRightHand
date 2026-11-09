import type { ComponentProps, ElementType } from "react";
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
