import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { FormDialog } from "@/components/dialogs";
import { EntityPicker } from "@/components/entity-picker";
import { FieldShell } from "@/components/form";
import { Input } from "@/components/ui/input";
import { useAddUserGroupMember, useCreateUserGroup, useRenameUserGroup } from "./api";

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
			submitLabel={group ? <Trans>Rename</Trans> : <Trans>New user group</Trans>}
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

/**
 * Add an existing user to one user group from the user's own page: the
 * inverse direction of `UserGroupAddMemberDialog` and the same membership API.
 */
export function AddUserToGroupDialog({
	user,
	excludeGroupIds,
	onClose,
}: {
	user: { id: string; username: string };
	/** The groups the user already belongs to. */
	excludeGroupIds: readonly string[];
	onClose: () => void;
}) {
	const { t } = useLingui();
	const prefix = useId();
	const add = useAddUserGroupMember();
	const [groupId, setGroupId] = useState("");
	const error = add.error instanceof Error ? add.error.message : undefined;

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Add to user group</Trans>}
			description={<Trans>{user.username} gains the node access this user group grants.</Trans>}
			submitLabel={<Trans>Add</Trans>}
			busy={add.isPending}
			submitDisabled={groupId === ""}
			error={error}
			onSubmit={() =>
				add.mutate(
					{ groupId, userId: user.id },
					{
						onSuccess: () => {
							onClose();
						},
					},
				)
			}
			testId="add-to-group-dialog"
		>
			<FieldShell id={`${prefix}-group`} label={t`User group`}>
				<EntityPicker
					id={`${prefix}-group`}
					kind="userGroup"
					label={t`User group`}
					value={groupId === "" ? null : groupId}
					onChange={(id) => setGroupId(id ?? "")}
					exclude={excludeGroupIds}
					className="w-full"
				/>
			</FieldShell>
		</FormDialog>
	);
}

/**
 * Add one user to a group. Membership is edited in the members section's own
 * action dialog, so the section itself stays a plain table.
 */
export function UserGroupAddMemberDialog({
	group,
	onClose,
}: {
	group: { id: string; name: string; memberIds: string[] };
	onClose: () => void;
}) {
	const { t } = useLingui();
	const prefix = useId();
	const add = useAddUserGroupMember();
	const [userId, setUserId] = useState("");
	const error = add.error instanceof Error ? add.error.message : undefined;

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Add member</Trans>}
			submitLabel={<Trans>Add</Trans>}
			busy={add.isPending}
			submitDisabled={userId === ""}
			error={error}
			onSubmit={() =>
				add.mutate(
					{ groupId: group.id, userId },
					{
						onSuccess: () => {
							onClose();
						},
					},
				)
			}
			testId="add-member-dialog"
		>
			<FieldShell id={`${prefix}-member`} label={t`User`}>
				<EntityPicker
					id={`${prefix}-member`}
					kind="user"
					label={t`User`}
					value={userId === "" ? null : userId}
					onChange={(id) => setUserId(id ?? "")}
					exclude={group.memberIds}
					className="w-full"
				/>
			</FieldShell>
		</FormDialog>
	);
}
