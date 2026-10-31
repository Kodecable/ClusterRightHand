import { LoaderCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** An inline spinner; `label` is announced to screen readers. */
export function Spinner({
	className,
	label = "Loading",
	decorative = false,
}: {
	className?: string;
	label?: string;
	/** Set when the spinner sits inside a control that already has an accessible name. */
	decorative?: boolean;
}) {
	const icon = (
		<LoaderCircleIcon className={cn("size-5 animate-spin text-muted-foreground", className)} aria-hidden="true" />
	);
	if (decorative) return <span className="inline-flex items-center justify-center">{icon}</span>;
	return (
		<span role="status" aria-label={label} className="inline-flex items-center justify-center">
			{icon}
		</span>
	);
}
