import type { PublicNode } from "@crh/api";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { FormDialog } from "@/components/dialogs";
import { ErrorText } from "@/components/error-state";
import { NodeGroupPicker } from "@/components/node-group-picker";
import { Spinner } from "@/components/spinner";
import { useNodeGroups } from "@/features/node-groups/api";
import { useSetNodeGroups } from "./api";

/**
 * Replaces a node's node groups (D109). Administrator-only, for crha and SSH
 * nodes alike: both are managed here now, not by the node's own configuration.
 */
export function NodeGroupsDialog({ node, onClose }: { node: PublicNode; onClose: () => void }) {
	const nodeGroups = useNodeGroups();
	const save = useSetNodeGroups();
	const [selected, setSelected] = useState<string[]>(node.nodeGroups.map((group) => group.id));

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Node groups of {node.name}</Trans>}
			description={<Trans>A node can be in any number of node groups.</Trans>}
			submitLabel={<Trans>Save node groups</Trans>}
			busy={save.isPending}
			error={save.error instanceof Error ? save.error.message : undefined}
			onSubmit={() =>
				save.mutate(
					{ id: node.id, nodeGroups: selected },
					{
						onSuccess: () => {
							onClose();
						},
					},
				)
			}
			testId="node-groups-dialog"
		>
			{nodeGroups.isPending ? (
				<Spinner />
			) : (
				<NodeGroupPicker groups={nodeGroups.data ?? []} value={selected} onChange={setSelected} />
			)}
			<ErrorText error={nodeGroups.error} />
		</FormDialog>
	);
}
