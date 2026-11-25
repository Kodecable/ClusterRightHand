import type { PublicNode } from "@crh/api";
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The decision a pending node waits for (doc/design/webui.md "Node pages"). */
export type NodeDecision = "approve" | "reject";

/**
 * Whether a node has row actions at all: only an administrator decides a pending enrolment. The card
 * asks this too before rendering their wrapper, so an active node adds no empty gap to its header.
 */
export function hasNodeRowActions(node: PublicNode, admin: boolean): boolean {
	return admin && node.status === "pending";
}

/**
 * The node list's row actions: approve or reject one pending enrolment. The table's actions column and
 * the node card's header share them, and every click stops at the button, so a clickable card or row
 * never opens the node page as a side effect.
 */
export function NodeRowActions({
	node,
	admin,
	onDecide,
	className,
}: {
	node: PublicNode;
	admin: boolean;
	onDecide: (node: PublicNode, action: NodeDecision) => void;
	className?: string;
}) {
	if (!hasNodeRowActions(node, admin)) return null;
	return (
		<span className={cn("flex flex-nowrap items-center gap-1", className)} data-testid="node-row-actions">
			<Button
				type="button"
				size="xs"
				onClick={(event) => {
					event.stopPropagation();
					onDecide(node, "approve");
				}}
			>
				<Trans>Approve</Trans>
			</Button>
			<Button
				type="button"
				size="xs"
				variant="destructive"
				onClick={(event) => {
					event.stopPropagation();
					onDecide(node, "reject");
				}}
			>
				<Trans>Reject</Trans>
			</Button>
		</span>
	);
}
