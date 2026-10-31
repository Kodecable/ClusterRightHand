import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

/**
 * Temporary scaffolding for the routes whose pages arrive in the next run of
 * the WebUI rewrite. It is the only placeholder in the branch: every route is
 * declared and lazily loads its page module; the modules currently render this.
 */
export function PageNotBuilt({ title, description }: { title: ReactNode; description?: ReactNode }) {
	return (
		<div className="h-full overflow-auto p-6" data-slot="page-not-built">
			<PageHeader title={title} description={description} />
			<div className="mt-6">
				<EmptyState
					title={<Trans>This page has not been built yet</Trans>}
					description={
						<Trans>
							The shell, the shared components and the data layer are in place; the pages are written in the next step
							of the WebUI rewrite.
						</Trans>
					}
				/>
			</div>
		</div>
	);
}
