import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { FormDialog } from "@/components/dialogs";
import { FieldShell } from "@/components/form";
import { Input } from "@/components/ui/input";
import { useCreateUserGroup, useRenameUserGroup } from "./api";

/**
 * Create a user group or rename one. The name rule (lower-cased a-z, 0-9, ".",
 * "_" and "-") is enforced by the server, which also keeps names unique.
 */
export function UserGroupNameDialog({
	group,
	onClose,
}: {
	/** The group to rename; omitted when creating one. */
	group?: { id: string; name: string };
	onClose: () => void;
}) {
	const { t } = useLingui();
	const prefix = useId();
	const [name, setName] = useState(group?.name ?? "");
	const create = useCreateUserGroup();
	const rename = useRenameUserGroup();
	const mutation = group ? rename : create;
	const serverError = mutation.error instanceof Error ? mutation.error.message : undefined;

	const submit = () => {
		const trimmed = name.trim();
		if (trimmed === "") return;
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
			title={group ? <Trans>Rename user group</Trans> : <Trans>New user group</Trans>}
			description={group ? undefined : <Trans>A user group is used for session shares and node access grants.</Trans>}
			submitLabel={group ? <Trans>Rename</Trans> : <Trans>Create user group</Trans>}
			busy={mutation.isPending}
			submitDisabled={name.trim() === ""}
			error={serverError}
			onSubmit={submit}
			testId="user-group-name-dialog"
		>
			<FieldShell id={`${prefix}-name`} label={t`User group name`}>
				<Input id={`${prefix}-name`} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
			</FieldShell>
		</FormDialog>
	);
}
