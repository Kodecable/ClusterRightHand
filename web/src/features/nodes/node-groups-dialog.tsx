import type { PublicNode } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { FormDialog } from "@/components/dialogs";
import { EntityPicker } from "@/components/entity-picker";
import { useSetNodeGroups } from "./api";

/**
 * Replaces a node's node groups. Administrator-only, for crha and SSH
 * nodes alike: both are managed here now, not by the node's own configuration.
 */
export function NodeGroupsDialog({ node, onClose }: { node: PublicNode; onClose: () => void }) {
	const { t } = useLingui();
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
			<EntityPicker
				kind="nodeGroup"
				multiple
				label={t`Node groups`}
				value={selected}
				onChange={(ids) => setSelected(ids)}
			/>
		</FormDialog>
	);
}
