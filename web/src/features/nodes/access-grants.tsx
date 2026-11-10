import type { AccessTargetType, GranteeType, NodeAccessGrant } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog, FormDialog } from "@/components/dialogs";
import { TableEmpty } from "@/components/empty-state";
import { EntityPicker } from "@/components/entity-picker";
import { ErrorState } from "@/components/error-state";
import { FieldShell } from "@/components/form";
import { DateTime } from "@/components/relative-time";
import { RowRemoveButton } from "@/components/row-remove-button";
import { SectionHeader } from "@/components/section";
import { useTimeColumnWidth } from "@/components/time-column";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/session";
import { ApiError, errorMessage } from "@/lib/api/client";
import { cn, linkClass } from "@/lib/utils";
import { useCreateNodeAccessGrant, useDeleteNodeAccessGrant, useNodeAccessGrants } from "./access-api";

/** The display name of a grantee; a deleted one stays identifiable as such. */
function granteeDisplayName(i18n: I18n, grant: Pick<NodeAccessGrant, "granteeType" | "granteeName">): string {
	if (grant.granteeName !== null) return grant.granteeName;
	return i18n._(grant.granteeType === "user" ? msg`Deleted user` : msg`Deleted user group`);
}

/** The display name of a grant's target (a node or a node group). */
function targetDisplayName(i18n: I18n, grant: Pick<NodeAccessGrant, "targetType" | "targetName">): string {
	if (grant.targetName !== null) return grant.targetName;
	return i18n._(grant.targetType === "node" ? msg`Deleted node` : msg`Deleted node group`);
}

/** A "User" / "User group" badge, so a name alone never hides which kind of grantee it is. */
function GranteeTypeBadge({ type }: { type: GranteeType }) {
	return <Badge variant="secondary">{type === "user" ? <Trans>User</Trans> : <Trans>User group</Trans>}</Badge>;
}

/** A "Node" / "Node group" badge, so a target name alone never hides which kind of target it is. */
function TargetTypeBadge({ type }: { type: AccessTargetType }) {
	return <Badge variant="secondary">{type === "node" ? <Trans>Node</Trans> : <Trans>Node group</Trans>}</Badge>;
}

/** A link to the target of a grant; a deleted target has no page left to link to. */
export function AccessTargetLink({ grant, className }: { grant: NodeAccessGrant; className?: string }) {
	const { t } = useLingui();
	if (grant.targetName === null) {
		return (
			<span className={cn("italic text-muted-foreground", className)}>
				{grant.targetType === "node" ? <Trans>Deleted node</Trans> : <Trans>Deleted node group</Trans>}
			</span>
		);
	}
	if (grant.targetType === "node") {
		return (
			<Link to="/nodes/$nodeId" params={{ nodeId: grant.targetId }} className={cn(linkClass, className)}>
				{grant.targetName}
			</Link>
		);
	}
	return (
		<Link
			to="/node-groups/$nodeGroupId"
			params={{ nodeGroupId: grant.targetId }}
			className={cn(linkClass, className)}
			title={t`Node group`}
		>
			{grant.targetName}
		</Link>
	);
}

/** The confirmation of removing one grant; shared by the target page and the users page. */
function RemoveGrantDialog({
	grant,
	targetType,
	onClose,
}: {
	grant: NodeAccessGrant;
	targetType: AccessTargetType;
	onClose: () => void;
}) {
	const { t, i18n } = useLingui();
	const remove = useDeleteNodeAccessGrant();
	const name = granteeDisplayName(i18n, grant);
	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`Remove access for ${name}?`}
			description={
				targetType === "node" ? (
					<Trans>They can no longer see this node or run tasks on it.</Trans>
				) : (
					<Trans>They can no longer see the nodes in this node group or run tasks on them.</Trans>
				)
			}
			confirmLabel={t`Remove access`}
			busy={remove.isPending}
			onConfirm={() =>
				remove.mutate(grant.id, {
					onSuccess: () => {
						onClose();
					},
				})
			}
		>
			{remove.error !== null && remove.error !== undefined && <ErrorState error={remove.error} compact />}
		</ConfirmDialog>
	);
}

/**
 * The admin-only "Node access" section of a user or user group page
 * (doc/design/webui.md "User and user group pages"): one table row per grant the grantee holds, with the
 * target link, the creation time and a confirmed remove. The section action
 * grants another node or node group to the same grantee. The grant list
 * endpoint is administrator-only, so non-administrators do not see the section.
 */
export function GranteeNodeAccessSection({ granteeType, granteeId }: { granteeType: GranteeType; granteeId: string }) {
	const { t, i18n } = useLingui();
	const timeWidth = useTimeColumnWidth();
	const admin = useAuth().user?.kind === "admin";
	const grants = useNodeAccessGrants({ granteeType, granteeId }, admin);
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState<NodeAccessGrant>();
	const columns: DataTableColumn<NodeAccessGrant>[] = [
		{
			id: "target",
			header: t`Target`,
			minSize: 200,
			cell: ({ row }) => (
				<span className="flex min-w-0 items-center gap-1.5">
					<TargetTypeBadge type={row.original.targetType} />
					<AccessTargetLink grant={row.original} className="truncate" />
				</span>
			),
			meta: { title: (grant: NodeAccessGrant) => targetDisplayName(i18n, grant) },
		},
		{
			id: "created",
			header: t`Created`,
			size: timeWidth,
			cell: ({ row }) => <DateTime value={row.original.createdAt} />,
		},
		{
			id: "actions",
			header: actionsHeader,
			size: 90,
			cell: ({ row }) => {
				const target = targetDisplayName(i18n, row.original);
				const grantee = granteeDisplayName(i18n, row.original);
				return (
					<RowRemoveButton
						label={t`Remove access to ${target} for ${grantee}`}
						onClick={() => setRemoving(row.original)}
					/>
				);
			},
		},
	];

	if (!admin) return null;
	return (
		<section className="grid gap-2" aria-labelledby="grantee-node-access-heading" data-testid="grantee-node-access">
			<SectionHeader
				id="grantee-node-access-heading"
				title={<Trans>Node access</Trans>}
				actions={
					<Button type="button" variant="outline" size="sm" data-testid="add-access" onClick={() => setAdding(true)}>
						<PlusIcon />
						<Trans>Add access</Trans>
					</Button>
				}
			/>
			<DataTable
				label={t`Node access`}
				columns={columns}
				data={grants.data ?? []}
				getRowId={(grant) => grant.id}
				loading={grants.isLoading}
				empty={
					<TableEmpty>
						<Trans>No node access</Trans>
					</TableEmpty>
				}
			/>
			{grants.error !== null && grants.error !== undefined && (
				<ErrorState error={grants.error} compact retry={() => void grants.refetch()} />
			)}
			{adding && (
				<AddGranteeAccessDialog
					granteeType={granteeType}
					granteeId={granteeId}
					exclude={(grants.data ?? []).map((grant) => grant.targetId)}
					onClose={() => setAdding(false)}
				/>
			)}
			{removing && (
				<RemoveGrantDialog grant={removing} targetType={removing.targetType} onClose={() => setRemoving(undefined)} />
			)}
		</section>
	);
}

/** The "Add access" dialog: pick a user or a user group and grant it access to the page's target. */
function AddAccessDialog({
	targetType,
	targetId,
	exclude,
	onClose,
}: {
	targetType: AccessTargetType;
	targetId: string;
	/** Grantees that already hold a grant on this target. */
	exclude: readonly string[];
	onClose: () => void;
}) {
	const { t } = useLingui();
	const create = useCreateNodeAccessGrant();
	const [grantee, setGrantee] = useState<{ id: string; type: GranteeType } | null>(null);

	const error =
		create.error instanceof ApiError && create.error.status === 409
			? t`This user or user group already has access.`
			: create.error
				? errorMessage(create.error)
				: undefined;

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Add access</Trans>}
			description={
				targetType === "node" ? (
					<Trans>A granted user or user group can see this node and run tasks on it.</Trans>
				) : (
					<Trans>A granted user or user group can see the nodes in this node group and run tasks on them.</Trans>
				)
			}
			submitLabel={<Trans>Add access</Trans>}
			busy={create.isPending}
			submitDisabled={grantee === null}
			error={error}
			onSubmit={() => {
				if (grantee === null) return;
				create.mutate(
					{ granteeType: grantee.type, granteeId: grantee.id, targetType, targetId },
					{
						onSuccess: () => {
							onClose();
						},
					},
				);
			}}
			testId="add-access-dialog"
		>
			<FieldShell
				id="add-access-grantee"
				label={t`User or user group`}
				description={t`A user group grants access to every current member.`}
			>
				<EntityPicker
					id="add-access-grantee"
					kind="directory"
					label={t`User or user group`}
					value={grantee?.id ?? null}
					onChange={(id, option) => {
						if (id === null || option === null) {
							setGrantee(null);
							return;
						}
						setGrantee({ id, type: option.kind === "userGroup" ? "user_group" : "user" });
					}}
					exclude={exclude}
					className="w-full"
				/>
			</FieldShell>
		</FormDialog>
	);
}

/** The "Add access" dialog on a grantee's page: grant a user or user group a node or node group. */
function AddGranteeAccessDialog({
	granteeType,
	granteeId,
	exclude,
	onClose,
}: {
	granteeType: GranteeType;
	granteeId: string;
	/** Targets that this grantee already has a grant on. */
	exclude: readonly string[];
	onClose: () => void;
}) {
	const { t } = useLingui();
	const create = useCreateNodeAccessGrant();
	const [target, setTarget] = useState<{ id: string; type: AccessTargetType } | null>(null);

	const error =
		create.error instanceof ApiError && create.error.status === 409
			? t`This target is already granted to this user or user group.`
			: create.error
				? errorMessage(create.error)
				: undefined;

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Add access</Trans>}
			description={<Trans>The grantee can see the node or every node in the node group and run tasks on them.</Trans>}
			submitLabel={<Trans>Add access</Trans>}
			busy={create.isPending}
			submitDisabled={target === null}
			error={error}
			onSubmit={() => {
				if (target === null) return;
				create.mutate(
					{ granteeType, granteeId, targetType: target.type, targetId: target.id },
					{
						onSuccess: () => {
							onClose();
						},
					},
				);
			}}
			testId="grantee-add-access-dialog"
		>
			<FieldShell
				id="grantee-add-access-target"
				label={t`Node or node group`}
				description={t`Only targets without an existing grant are listed.`}
			>
				<EntityPicker
					id="grantee-add-access-target"
					kind="nodeTarget"
					label={t`Node or node group`}
					value={target?.id ?? null}
					onChange={(id, option) => {
						if (id === null || option === null) {
							setTarget(null);
							return;
						}
						setTarget({ id, type: option.kind === "nodeGroup" ? "node_group" : "node" });
					}}
					exclude={exclude}
					className="w-full"
				/>
			</FieldShell>
		</FormDialog>
	);
}

/**
 * The admin-only "Access" section of a node or node group page
 * (doc/design/access-control.md "Ownership, access grants and sharing"): who may see and run tasks on the
 * target, in a table whose section action opens the Add access dialog. Everyone
 * else does not see the section at all.
 */
export function NodeAccessSection({
	targetType,
	targetId,
	targetName,
}: {
	targetType: AccessTargetType;
	targetId: string;
	targetName: string;
}) {
	const { t, i18n } = useLingui();
	const timeWidth = useTimeColumnWidth();
	const admin = useAuth().user?.kind === "admin";
	const grants = useNodeAccessGrants({ targetType, targetId }, admin);
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState<NodeAccessGrant>();

	if (!admin) return null;
	const rows = grants.data ?? [];
	const columns: DataTableColumn<NodeAccessGrant>[] = [
		{
			id: "grantee",
			header: t`Grantee`,
			minSize: 160,
			cell: ({ row }) => {
				const name = granteeDisplayName(i18n, row.original);
				return (
					<span className="flex min-w-0 items-center gap-1.5">
						<GranteeTypeBadge type={row.original.granteeType} />
						<span className={row.original.granteeName === null ? "truncate italic text-muted-foreground" : "truncate"}>
							{name}
						</span>
					</span>
				);
			},
			meta: { title: (grant: NodeAccessGrant) => granteeDisplayName(i18n, grant) },
		},
		{
			id: "created",
			header: t`Created`,
			size: timeWidth,
			cell: ({ row }) => <DateTime value={row.original.createdAt} />,
		},
		{
			id: "actions",
			header: actionsHeader,
			size: 90,
			cell: ({ row }) => {
				const name = granteeDisplayName(i18n, row.original);
				return <RowRemoveButton label={t`Remove access for ${name}`} onClick={() => setRemoving(row.original)} />;
			},
		},
	];

	return (
		<section className="grid gap-2" aria-labelledby="node-access-heading" data-testid="node-access">
			<SectionHeader
				id="node-access-heading"
				title={<Trans>Access</Trans>}
				actions={
					<Button type="button" variant="outline" size="sm" data-testid="add-access" onClick={() => setAdding(true)}>
						<PlusIcon />
						<Trans>Add access</Trans>
					</Button>
				}
			/>
			<DataTable
				label={t`Access grants for ${targetName}`}
				columns={columns}
				data={rows}
				getRowId={(grant) => grant.id}
				loading={grants.isLoading}
				empty={
					<TableEmpty>
						<Trans>No access grants</Trans>
					</TableEmpty>
				}
			/>
			{grants.error !== null && grants.error !== undefined && (
				<ErrorState error={grants.error} compact retry={() => void grants.refetch()} />
			)}
			{adding && (
				<AddAccessDialog
					targetType={targetType}
					targetId={targetId}
					exclude={rows.map((grant) => grant.granteeId)}
					onClose={() => setAdding(false)}
				/>
			)}
			{removing && (
				<RemoveGrantDialog grant={removing} targetType={targetType} onClose={() => setRemoving(undefined)} />
			)}
		</section>
	);
}
