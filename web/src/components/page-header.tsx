import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A page heading: title, optional one-line description and an actions area. */
export function PageHeader({
	title,
	description,
	actions,
	className,
	children,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
	children?: ReactNode;
}) {
	return (
		<div data-slot="page-header" className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
			<div className="min-w-0 space-y-1">
				<h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
				{description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
				{children}
			</div>
			{actions !== undefined && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}
