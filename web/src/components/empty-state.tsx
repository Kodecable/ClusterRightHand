import { useLingui } from "@lingui/react/macro";
import { InboxIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The "nothing here yet" block of a list or page. */
export function EmptyState({
	title,
	description,
	action,
	icon,
	className,
	bare = false,
}: {
	title: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	icon?: ReactNode;
	className?: string;
	/**
	 * Drop the dashed frame: the parent already draws one (DataTable's empty
	 * state renders inside the table's own border).
	 */
	bare?: boolean;
}) {
	return (
		<div
			data-slot="empty-state"
			className={cn(
				"flex flex-col items-center justify-center gap-2 text-center",
				bare ? "px-4 py-10" : "rounded-lg border border-dashed px-4 py-12",
				className,
			)}
		>
			<div className="text-muted-foreground" aria-hidden="true">
				{icon ?? <InboxIcon className="size-6" />}
			</div>
			<p className="text-sm font-medium">{title}</p>
			{description !== undefined && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
			{action !== undefined && <div className="mt-1">{action}</div>}
		</div>
	);
}

/** A compact empty hint for a section inside a page. */
export function EmptyHint({ children, className }: { children?: ReactNode; className?: string }) {
	const { t } = useLingui();
	return (
		<p className={cn("text-sm text-muted-foreground", className)} data-slot="empty-hint">
			{children ?? t`Nothing here yet.`}
		</p>
	);
}

/**
 * The one empty state inside a DataTable's own frame (doc/design/webui.md "Shared components"):
 * a single small muted line, no icon, title or second border, so every empty
 * section table looks the same. Pass it as the table's `empty`.
 */
export function TableEmpty({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<p className={cn("px-4 py-6 text-center text-sm text-muted-foreground", className)} data-slot="table-empty">
			{children}
		</p>
	);
}
