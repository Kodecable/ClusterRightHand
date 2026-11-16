import { Trans } from "@lingui/react/macro";
import { LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Panel } from "@/components/section";
import { cn } from "@/lib/utils";

/**
 * Auto Review is still judging a request (doc/design/access-control.md "Auto Review"): the direct task,
 * task group and external call pages show this notice instead of decision controls. The session dock and
 * the approvals lists never show the request at all while this runs.
 */
export function ReviewingNotice({ summary, className }: { summary?: ReactNode; className?: string }) {
	return (
		<Panel
			as="section"
			data-slot="decision"
			data-kind="approval"
			data-phase="reviewing"
			className={cn("grid min-w-0 gap-2 bg-card text-card-foreground", className)}
		>
			<p
				role="status"
				data-testid="reviewing-notice"
				className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
			>
				<LoaderCircleIcon className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
				<span>
					<Trans>Auto Review is reviewing this request</Trans>
				</span>
			</p>
			{summary}
		</Panel>
	);
}
