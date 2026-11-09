import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A page heading: title, optional one-line description and an actions area.
 * Both sides may shrink and wrap, so a narrow screen stacks the actions under
 * the title instead of pushing them off the page. The title itself wraps to at
 * most two lines (long commands and paths break anywhere) and keeps its full
 * text in the `title` tooltip, so no title can widen the page.
 */
export function PageHeader({
	title,
	titleText,
	description,
	actions,
	className,
	children,
}: {
	title: ReactNode;
	/** Plain text of the title for the tooltip; a string title is used as is. */
	titleText?: string;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
	children?: ReactNode;
}) {
	const fullTitle = titleText ?? (typeof title === "string" ? title : undefined);
	return (
		<div
			data-slot="page-header"
			className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}
		>
			<div className="min-w-0 flex-1 basis-64 space-y-1">
				<h1
					title={fullTitle}
					className="line-clamp-2 min-w-0 break-words text-xl font-semibold tracking-tight [overflow-wrap:anywhere]"
				>
					{title}
				</h1>
				{description !== undefined && (
					<p className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{description}</p>
				)}
				{children}
			</div>
			{actions !== undefined && (
				<div className="flex min-w-0 shrink flex-wrap items-center gap-2" data-slot="page-actions">
					{actions}
				</div>
			)}
		</div>
	);
}
