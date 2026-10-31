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
}: {
	title: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	icon?: ReactNode;
	className?: string;
}) {
	return (
		<div
			data-slot="empty-state"
			className={cn(
				"flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center",
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
export function EmptyHint({ children }: { children?: ReactNode }) {
	const { t } = useLingui();
	return (
		<p className="text-sm text-muted-foreground" data-slot="empty-hint">
			{children ?? t`Nothing here yet.`}
		</p>
	);
}
