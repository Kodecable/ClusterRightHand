import type { PublicNode } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { ConfirmDialog } from "@/components/dialogs";
import { ErrorState } from "@/components/error-state";
import { useApproveNode, useDeleteNode } from "./api";

/** The approve/reject confirmation of a pending node, with its key fingerprint. */
export function PendingNodeDialog({
	node,
	action,
	onClose,
	onDone,
}: {
	node: PublicNode;
	action: "approve" | "reject";
	onClose: () => void;
	onDone: () => void;
}) {
	const { t } = useLingui();
	const approve = useApproveNode();
	const remove = useDeleteNode();
	const busy = approve.isPending || remove.isPending;
	const isApprove = action === "approve";
	const error = isApprove ? approve.error : remove.error;
	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={isApprove ? t`Approve node` : t`Reject node`}
			description={
				isApprove ? (
					node.hostname !== null && node.hostname !== node.name ? (
						<Trans>
							Approve <strong>{node.hostname}</strong> (named {node.name})?
						</Trans>
					) : (
						<Trans>
							Approve <strong>{node.hostname ?? node.name}</strong>?
						</Trans>
					)
				) : node.hostname !== null && node.hostname !== node.name ? (
					<Trans>
						Reject and delete <strong>{node.hostname}</strong> (named {node.name})?
					</Trans>
				) : (
					<Trans>
						Reject and delete <strong>{node.hostname ?? node.name}</strong>?
					</Trans>
				)
			}
			confirmLabel={isApprove ? t`Approve` : t`Reject`}
			destructive={!isApprove}
			busy={busy}
			onConfirm={() => {
				const mutation = isApprove ? approve : remove;
				mutation.mutate(node.id, {
					onSuccess: () => {
						onDone();
					},
				});
			}}
		>
			{isApprove && (
				<div className="grid gap-1 text-sm">
					<p>
						<Trans>
							Node key fingerprint: <code className="font-mono">{node.keyFingerprint ?? t`unknown`}</code>
						</Trans>
					</p>
					<p className="text-muted-foreground">
						<Trans>
							It must match what <code>crha enroll</code> printed, or <code>crha status</code> on the node, before you
							approve.
						</Trans>
					</p>
				</div>
			)}
			{error !== null && <ErrorState error={error} compact />}
		</ConfirmDialog>
	);
}
