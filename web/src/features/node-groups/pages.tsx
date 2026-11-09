import type { NodeGroup } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PencilIcon, PlusIcon, Trash2Icon, UserPenIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyHint, EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { NodeLink } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/session";
import { NodeAccessSection } from "@/features/nodes/access-grants";
import { useNodes } from "@/features/nodes/api";
import { cn, linkClass, MONO_CELL } from "@/lib/utils";
import { useDeleteNodeGroup, useNodeGroups } from "./api";
import { NodeGroupMembersDialog, NodeGroupNameDialog } from "./dialogs";

/** The members of a node group, each linked to its node page. */
function MemberLinks({
	memberIds,
	nodeNames,
	className,
}: {
	memberIds: string[];
	nodeNames: Map<string, string>;
	className?: string;
}) {
	if (memberIds.length === 0) return <span className="text-muted-foreground">–</span>;
	return (
		<span className={cn("flex flex-wrap items-center gap-x-1", className)}>
			{memberIds.map((id, index) => (
				<Fragment key={id}>
					{index > 0 && <span className="text-muted-foreground">,</span>}
					<NodeLink id={id} name={nodeNames.get(id) ?? id} />
				</Fragment>
			))}
		</span>
	);
}

/** The header actions an administrator gets for one node group. */
function AdminActions({
	onRename,
	onEditMembers,
	onDelete,
}: {
	onRename: () => void;
	onEditMembers: () => void;
	onDelete: () => void;
}) {
	return (
		<>
			<Button type="button" variant="outline" size="sm" onClick={onEditMembers}>
				<UserPenIcon />
				<Trans>Edit members</Trans>
			</Button>
			<Button type="button" variant="outline" size="sm" onClick={onRename}>
				<PencilIcon />
				<Trans>Rename</Trans>
			</Button>
			<Button type="button" variant="destructive" size="sm" onClick={onDelete}>
				<Trash2Icon />
				<Trans>Delete</Trans>
			</Button>
		</>
	);
}

/**
 * Every node group (doc/access-control.md#用户模型, D109): members links and the
 * UUID to copy for a crha trust alias. Editing lives on the detail page; the
 * list only navigates. Everyone else sees the list read-only.
 */
export function NodeGroupsPage() {
	const { t } = useLingui();
	const nodes = useNodes();
	const groups = useNodeGroups();
	const admin = useAuth().user?.kind === "admin";
	const [creating, setCreating] = useState(false);
	const nodeNames = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);

	const columns = useMemo<DataTableColumn<NodeGroup>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				minSize: 140,
				cell: ({ row }) => <span className="truncate font-medium">{row.original.name}</span>,
				meta: { title: (group: NodeGroup) => group.name },
			},
			{
				id: "members",
				header: t`Members`,
				size: 280,
				cell: ({ row }) => (
					<span className="grid gap-0.5">
						<span className="text-muted-foreground">
							<Plural value={row.original.memberIds.length} one="# member" other="# members" />
						</span>
						<MemberLinks memberIds={row.original.memberIds} nodeNames={nodeNames} />
					</span>
				),
			},
			{
				id: "id",
				header: t`Node group id`,
				size: 300,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-1">
						<code className={cn("truncate text-muted-foreground", MONO_CELL)}>{row.original.id}</code>
						<CopyButton
							text={row.original.id}
							label={t`Copy node group id of ${row.original.name}`}
							variant="ghost"
							size="icon-xs"
						/>
					</span>
				),
			},
		],
		[nodeNames, t],
	);

	return (
		<Page data-testid="node-groups-page">
			<PageHeader
				title={<Trans>Node groups</Trans>}
				description={
					<Trans>
						Node groups select several nodes at once, for rules, batch runs and schedules. A node can be in any number
						of node groups.
					</Trans>
				}
				actions={
					admin ? (
						<Button type="button" onClick={() => setCreating(true)} data-testid="create-node-group">
							<PlusIcon />
							<Trans>New node group</Trans>
						</Button>
					) : undefined
				}
			/>
			<DataTable
				label={t`Node groups`}
				columns={columns}
				data={groups.data ?? []}
				getRowId={(group) => group.id}
				loading={groups.isLoading}
				error={groups.isError ? groups.error : undefined}
				onRetry={() => void groups.refetch()}
				rowLink={(group) => ({ to: "/node-groups/$nodeGroupId", params: { nodeGroupId: group.id } })}
				rowLabel={(group) => group.name}
				empty={
					<EmptyState
						bare
						title={<Trans>No node groups yet</Trans>}
						description={
							admin ? (
								<Trans>Create a node group to run the same task on several nodes.</Trans>
							) : (
								<Trans>An administrator creates node groups.</Trans>
							)
						}
					/>
				}
			/>
			{creating && <NodeGroupNameDialog onClose={() => setCreating(false)} />}
		</Page>
	);
}

/** One node group: its UUID, member nodes and (for administrators) its actions. */
export function NodeGroupDetailPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { nodeGroupId?: string };
	const id = params.nodeGroupId ?? "";
	const groups = useNodeGroups();
	const nodes = useNodes();
	const admin = useAuth().user?.kind === "admin";
	const remove = useDeleteNodeGroup();
	const navigate = useNavigate();
	const [renaming, setRenaming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [editingMembers, setEditingMembers] = useState(false);
	const group = groups.data?.find((candidate) => candidate.id === id);
	const nodeNames = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);

	if (groups.isError) {
		return (
			<Page width="detail">
				<ErrorState error={groups.error} retry={() => void groups.refetch()} />
			</Page>
		);
	}
	if (!groups.data) {
		return (
			<Page width="detail">
				<PageSkeleton />
			</Page>
		);
	}
	if (!group) {
		return (
			<Page width="detail" data-testid="node-group-detail">
				<EmptyState
					title={<Trans>No such node group</Trans>}
					description={<Trans>It may have been deleted.</Trans>}
					action={
						<Link to="/node-groups" className={linkClass}>
							<Trans>All node groups</Trans>
						</Link>
					}
				/>
			</Page>
		);
	}

	return (
		<Page width="detail" data-testid="node-group-detail">
			<div>
				<Link
					to="/node-groups"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All node groups</Trans>
				</Link>
			</div>
			<PageHeader
				title={group.name}
				description={
					<span className="text-sm text-muted-foreground">
						<Plural value={group.memberIds.length} one="# member" other="# members" />
					</span>
				}
				actions={
					admin ? (
						<AdminActions
							onRename={() => setRenaming(true)}
							onEditMembers={() => setEditingMembers(true)}
							onDelete={() => setDeleting(true)}
						/>
					) : undefined
				}
			/>

			<KeyValueList
				items={[
					{
						label: t`Node group id`,
						value: (
							<span className="flex min-w-0 items-center gap-1">
								<code className={MONO_CELL}>{group.id}</code>
								<CopyButton text={group.id} label={t`Copy node group id`} variant="ghost" size="icon-xs" />
							</span>
						),
						control: true,
					},
				]}
			/>

			<section className="grid gap-2" aria-labelledby="node-group-members-heading">
				<h2 id="node-group-members-heading" className="text-sm font-medium">
					<Trans>Members</Trans>
				</h2>
				{group.memberIds.length === 0 ? (
					<EmptyHint>
						<Trans>No members</Trans>
					</EmptyHint>
				) : (
					<ul className="flex flex-wrap gap-2" aria-label={t`Members of ${group.name}`}>
						{group.memberIds.map((nodeId) => (
							<li key={nodeId} className="inline-flex min-h-8 items-center rounded-md border px-2 text-sm">
								<NodeLink id={nodeId} name={nodeNames.get(nodeId) ?? nodeId} />
							</li>
						))}
					</ul>
				)}
				{admin && (
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="justify-self-start"
						onClick={() => setEditingMembers(true)}
					>
						<UserPenIcon />
						<Trans>Edit members</Trans>
					</Button>
				)}
			</section>

			<NodeAccessSection targetType="node_group" targetId={group.id} targetName={group.name} />

			{renaming && <NodeGroupNameDialog group={group} onClose={() => setRenaming(false)} />}
			{editingMembers && (
				<NodeGroupMembersDialog group={group} nodes={nodes.data ?? []} onClose={() => setEditingMembers(false)} />
			)}
			<ConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title={t`Delete node group ${group.name}?`}
				description={
					<Trans>
						Its members lose this node group. Rules and task groups that reference it keep the reference and display it
						as deleted.
					</Trans>
				}
				confirmLabel={<Trans>Delete node group</Trans>}
				busy={remove.isPending}
				onConfirm={() =>
					remove.mutate(group.id, {
						onSuccess: () => {
							void navigate({ to: "/node-groups" });
						},
					})
				}
			/>
			{remove.error !== null && remove.error !== undefined && (
				<ErrorState error={remove.error} compact retry={() => void remove.reset()} />
			)}
		</Page>
	);
}
