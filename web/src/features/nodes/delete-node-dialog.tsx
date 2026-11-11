import type { PublicNode } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { ConfirmDialog } from "@/components/dialogs";
import { ErrorState } from "@/components/error-state";
import { useDeleteNode } from "./api";

/**
 * Confirms deleting a node from the node page (doc/guide/webui.md "Deleting a node"). The server
 * removes its access grants and node group memberships and ends its waiting tasks; an active crha
 * node is told it was removed and stops, while an SSH node's host is not contacted.
 */
export function DeleteNodeDialog({ node, onClose }: { node: PublicNode; onClose: () => void }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const remove = useDeleteNode();
	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`Delete node ${node.name}?`}
			description={
				node.transport === "ssh" ? (
					<Trans>
						No crha runs on the host, so nothing is sent to it. Tasks waiting for this node are ended, and its access
						grants and node group memberships are removed. Its credential stays in SSH credentials.
					</Trans>
				) : (
					<Trans>
						crha on the node is told it was removed, disconnects and stops. Tasks waiting for this node are ended. Its
						access grants and node group memberships are removed. To add the host again, enroll it with a new token
						after deleting its identity.key and server.pub.
					</Trans>
				)
			}
			confirmLabel={<Trans>Delete node</Trans>}
			busy={remove.isPending}
			onConfirm={() =>
				remove.mutate(node.id, {
					onSuccess: () => {
						void navigate({ to: "/nodes" });
					},
				})
			}
		>
			{remove.error !== null && <ErrorState error={remove.error} compact />}
		</ConfirmDialog>
	);
}
