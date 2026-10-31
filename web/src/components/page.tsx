import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The content width of detail and form pages. List pages span the whole main
 * area; everything else starts at the same left edge in this column, header
 * included, instead of being centred or full width like the old pages.
 */
export const DETAIL_WIDTH = "max-w-5xl";

/**
 * The frame of a routed page: one scrolling area and one content column
 * (doc/webui.md "外壳"). The page's own header and body both live in the
 * column, so a detail page does not have its title on the far left and its
 * form somewhere else.
 */
export function Page({
	width = "full",
	className,
	children,
	...rest
}: HTMLAttributes<HTMLDivElement> & { width?: "full" | "detail" }) {
	return (
		<div className={cn("flex h-full min-h-0 flex-col overflow-auto p-4", className)} {...rest}>
			<div className={cn("grid w-full content-start gap-3", width === "detail" && DETAIL_WIDTH)}>{children}</div>
		</div>
	);
}
