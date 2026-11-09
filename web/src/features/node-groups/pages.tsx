import type { NodeGroup } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PencilIcon, PlusIcon, Trash2Icon, UserPenIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState, TableEmpty } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { NodeLink } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section";
import { PageSkeleton } from "@/components/skeletons";
import { NodeStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/session";
import { NodeAccessSection } from "@/features/nodes/access-grants";
import { useNodes } from "@/features/nodes/api";
import { cn, linkClass, MONO_CELL } from "@/lib/utils";
import { useDeleteNodeGroup, useNodeGroups } from "./api";
import { NodeGroupMembersDialog, NodeGroupNameDialog } from "./dialogs";

/** One row of the member table: the stored node id and nothing else. */
interface MemberRow {
	nodeId: string;
}

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

/** The header actions an administrator gets for one node group; members are edited in their section. */
function AdminActions({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
	return (
		<>
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
	const nodeById = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node])), [nodes.data]);
	const memberName = useMemo(
		() => (memberId: string) => nodeById.get(memberId)?.name ?? nodeNames.get(memberId) ?? memberId,
		[nodeById, nodeNames],
	);
	const memberColumns = useMemo<DataTableColumn<MemberRow>[]>(
		() => [
			{
				id: "name",
				header: t`Node`,
				minSize: 160,
				cell: ({ row }) => <span className="truncate font-medium">{memberName(row.original.nodeId)}</span>,
				meta: { title: (member: MemberRow) => memberName(member.nodeId) },
			},
			{
				id: "status",
				header: t`Status`,
				size: 90,
				cell: ({ row }) => {
					const node = nodeById.get(row.original.nodeId);
					return node === undefined ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<NodeStatusBadge status={node.status} connected={node.connected} />
					);
				},
			},
			{
				id: "hostname",
				header: t`Hostname`,
				minSize: 140,
				cell: ({ row }) => {
					const hostname = nodeById.get(row.original.nodeId)?.hostname;
					return hostname === null || hostname === undefined || hostname === "" ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<span className={cn("truncate", MONO_CELL)}>{hostname}</span>
					);
				},
				meta: { title: (member: MemberRow) => nodeById.get(member.nodeId)?.hostname ?? undefined },
			},
		],
		[memberName, nodeById, t],
	);

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
					admin ? <AdminActions onRename={() => setRenaming(true)} onDelete={() => setDeleting(true)} /> : undefined
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

			<section className="grid gap-2" aria-labelledby="node-group-members-heading" data-testid="node-group-members">
				<SectionHeader
					id="node-group-members-heading"
					title={<Trans>Members</Trans>}
					actions={
						admin ? (
							<Button type="button" size="sm" variant="outline" onClick={() => setEditingMembers(true)}>
								<UserPenIcon />
								<Trans>Edit members</Trans>
							</Button>
						) : undefined
					}
				/>
				<DataTable
					label={t`Members of ${group.name}`}
					columns={memberColumns}
					data={group.memberIds.map((nodeId) => ({ nodeId }))}
					getRowId={(member) => member.nodeId}
					rowLink={(member) => ({ to: "/nodes/$nodeId", params: { nodeId: member.nodeId } })}
					rowLabel={(member) => memberName(member.nodeId)}
					empty={
						<TableEmpty>
							<Trans>No members</Trans>
						</TableEmpty>
					}
				/>
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
