import type { NodeGroup, PublicNode } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { FormDialog } from "@/components/dialogs";
import { EmptyHint } from "@/components/empty-state";
import { FieldShell } from "@/components/form";
import { NodePicker } from "@/components/node-picker";
import { Input } from "@/components/ui/input";
import { NAME_MAX, type NameProblem, nameProblem } from "@/lib/names";
import { useCreateNodeGroup, useRenameNodeGroup, useSetNodeGroupMembers } from "./api";

const NAME_PROBLEMS: Record<NameProblem, MessageDescriptor> = {
	empty: msg`A node group name is required.`,
	reserved: msg`A node group name must not start with "_": names starting with "_" are reserved for the system.`,
	format: msg`A node group name must be 2-64 characters, start with a letter, end with a letter or digit, and contain only letters, digits, ".", "_", "/" or "-".`,
};

function nameErrorText(i18n: I18n, name: string): string | undefined {
	const problem = nameProblem(name);
	return problem === undefined ? undefined : i18n._(NAME_PROBLEMS[problem]);
}

/** Create a node group or rename one; the name rule is checked here and again by the server. */
export function NodeGroupNameDialog({
	group,
	onClose,
}: {
	/** The group to rename; omitted when creating one. */
	group?: NodeGroup;
	onClose: () => void;
}) {
	const { t, i18n } = useLingui();
	const prefix = useId();
	const [name, setName] = useState(group?.name ?? "");
	const [localError, setLocalError] = useState<string>();
	const create = useCreateNodeGroup();
	const rename = useRenameNodeGroup();
	const mutation = group ? rename : create;
	const serverError = mutation.error instanceof Error ? mutation.error.message : undefined;

	const submit = () => {
		const problem = nameErrorText(i18n, name);
		if (problem !== undefined) {
			setLocalError(problem);
			return;
		}
		setLocalError(undefined);
		const trimmed = name.trim();
		if (group) {
			rename.mutate(
				{ id: group.id, name: trimmed },
				{
					onSuccess: () => {
						onClose();
					},
				},
			);
		} else {
			create.mutate(trimmed, {
				onSuccess: () => {
					onClose();
				},
			});
		}
	};

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={group ? <Trans>Rename node group</Trans> : <Trans>New node group</Trans>}
			description={
				group ? undefined : <Trans>A node group selects several nodes for rules, batch runs and schedules.</Trans>
			}
			submitLabel={group ? <Trans>Rename</Trans> : <Trans>Create node group</Trans>}
			busy={mutation.isPending}
			submitDisabled={name.trim() === ""}
			error={localError ?? serverError}
			onSubmit={submit}
			testId="node-group-name-dialog"
		>
			<FieldShell id={`${prefix}-name`} label={t`Node group name`}>
				<Input
					id={`${prefix}-name`}
					value={name}
					maxLength={NAME_MAX}
					onChange={(event) => {
						setName(event.target.value);
						setLocalError(undefined);
					}}
				/>
			</FieldShell>
		</FormDialog>
	);
}

/** Replace a node group's members: every node that should belong to it. */
export function NodeGroupMembersDialog({
	group,
	nodes,
	onClose,
}: {
	group: NodeGroup;
	nodes: PublicNode[];
	onClose: () => void;
}) {
	const { t } = useLingui();
	const [selected, setSelected] = useState<string[]>(group.memberIds);
	const save = useSetNodeGroupMembers();
	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Members of {group.name}</Trans>}
			description={<Trans>The node group contains exactly the nodes selected here.</Trans>}
			submitLabel={<Trans>Save members</Trans>}
			busy={save.isPending}
			error={save.error instanceof Error ? save.error.message : undefined}
			onSubmit={() =>
				save.mutate(
					{ id: group.id, nodeIds: selected },
					{
						onSuccess: () => {
							onClose();
						},
					},
				)
			}
			testId="node-group-members-dialog"
		>
			{nodes.length === 0 ? (
				<EmptyHint>{t`There are no nodes to add yet.`}</EmptyHint>
			) : (
				<NodePicker multiple nodes={nodes} value={selected} onChange={setSelected} label={t`Nodes`} />
			)}
		</FormDialog>
	);
}
