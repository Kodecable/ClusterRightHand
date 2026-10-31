import { Trans } from "@lingui/react/macro";
import { EmptyState } from "@/components/empty-state";

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
				description={<Trans>Pick a session on the left, or start a new one.</Trans>}
			/>
		</div>
	);
}
