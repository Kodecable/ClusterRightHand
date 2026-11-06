import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";

/**
 * The sessions route's empty state. Kept apart from the session page so the
 * transcript and its Markdown renderer stay out of the chunk the list needs.
 */
export function SessionsPage() {
	return (
		<div className="flex h-full items-center justify-center p-6">
			<EmptyState
				className="max-w-md border-0"
				title={<Trans>No session selected</Trans>}
				description={<Trans>Pick a session from the list, or start a new one.</Trans>}
				action={
					<Link to="/sessions/new" className={buttonVariants({ variant: "default", size: "sm" })}>
						<PlusIcon />
						<Trans>New session</Trans>
					</Link>
				}
			/>
		</div>
	);
}
