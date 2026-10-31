import { Trans } from "@lingui/react/macro";
import { CircleAlertIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/utils";

/**
 * A failed query. The message comes from the server and is shown verbatim
 * (server and agent messages are not translated); only the surrounding text is.
 */
export function ErrorState({
	error,
	retry,
	className,
	compact = false,
}: {
	error: unknown;
	retry?: () => void;
	className?: string;
	compact?: boolean;
}) {
	const message = errorMessage(error);
	return (
		<div
			data-slot="error-state"
			role="alert"
			className={cn(
				"flex flex-col items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg text-center text-danger",
				compact ? "px-3 py-2" : "px-4 py-8",
				className,
			)}
		>
			<div className="flex items-center gap-2">
				<CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
				<p className="text-sm font-medium">
					<Trans>Something went wrong</Trans>
				</p>
			</div>
			<p className="max-w-lg text-sm break-words opacity-90">{message}</p>
			{retry !== undefined && (
				<Button type="button" size="sm" variant="outline" onClick={retry}>
					<RotateCwIcon />
					<Trans>Try again</Trans>
				</Button>
			)}
		</div>
	);
}

/** A one-line inline error, for forms and cards. */
export function ErrorText({ error, className }: { error: unknown; className?: string }) {
	if (error === null || error === undefined || error === "") return null;
	return (
		<p role="alert" className={cn("text-sm text-danger", className)}>
			{errorMessage(error)}
		</p>
	);
}
