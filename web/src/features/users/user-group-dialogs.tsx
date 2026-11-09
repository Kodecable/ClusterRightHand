import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { FormDialog } from "@/components/dialogs";
import { EmptyHint } from "@/components/empty-state";
import { FieldShell } from "@/components/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAddUserGroupMember, useCreateUserGroup, useRenameUserGroup, useUsers } from "./api";

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
	const users = useUsers();
	const add = useAddUserGroupMember();
	const [userId, setUserId] = useState("");
	const candidates = (users.data ?? []).filter((user) => !group.memberIds.includes(user.id));
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
				<Select value={userId === "" ? null : userId} onValueChange={(next) => setUserId(String(next ?? ""))}>
					<SelectTrigger id={`${prefix}-member`}>
						<SelectValue placeholder={t`Select…`}>
							{(selected: string | null) => candidates.find((user) => user.id === selected)?.username ?? t`Select…`}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{candidates.map((user) => (
							<SelectItem key={user.id} value={user.id}>
								{user.username}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</FieldShell>
			{candidates.length === 0 && !users.isLoading && (
				<EmptyHint>
					<Trans>Everyone is already a member.</Trans>
				</EmptyHint>
			)}
		</FormDialog>
	);
}
