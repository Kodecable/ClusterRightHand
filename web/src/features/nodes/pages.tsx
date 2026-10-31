import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { FieldShell } from "@/components/form";
import { KeyValueList } from "@/components/key-value";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { PageSkeleton } from "@/components/skeletons";
import { NodeStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/session";
import { useCredentials } from "@/features/credentials/api";
import type { PublicNode } from "@/lib/api/types";
import { AddNodeDialog } from "./add-node-dialog";
import { useApproveNode, useCrhsKey, useDeleteNode, useNode, useNodes, useRenameNode } from "./api";
import { osName } from "./commands";
import { CrhsKeyPanel } from "./crhs-key-panel";
import { NodeShares } from "./node-shares";
import { NodeTaskList } from "./node-tasks";
import { NodeTrustPanel } from "./node-trust";
import { RunPanel } from "./run-panel";
import { SshNodeSection } from "./ssh-node-section";
import { SshNodeWizard } from "./ssh-wizard";
import type { TrustKeySource } from "./trust-editor";
import { TrustEditor } from "./trust-editor-panel";

/** Whether the caller may run tasks on this node (doc/access-control.md#节点访问). */
function canRunOn(node: PublicNode): boolean {
	return node.status === "active" && (node.access === "owner" || node.access === "admin" || node.access === "operate");
}

function canManageNode(node: PublicNode): boolean {
	return node.access === "owner" || node.access === "admin";
}

function ClockWarning({ warning }: { warning: string | null }) {
	if (warning === null) return null;
	return (
		<span className="inline-flex items-center gap-1 text-xs text-warn" title={warning}>
			<TriangleAlertIcon className="size-3.5" aria-hidden="true" />
			<Trans>clock</Trans>
		</span>
	);
}

function AddSshNodeDialog({ onClose }: { onClose: () => void }) {
	const navigate = useNavigate();
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>Add SSH node</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Choose a credential, describe the route (jump hosts, then the target), pin every host key, then create the
							node.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="max-h-[70vh] overflow-auto pr-1">
					<SshNodeWizard
						onCancel={onClose}
						onCreated={(node) => {
							onClose();
							void navigate({ to: "/nodes/$nodeId", params: { nodeId: node.id } });
						}}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function PendingNodeDialog({
	node,
	action,
	onClose,
	onDone,
}: {
	node: PublicNode;
	action: "approve" | "reject";
	onClose: () => void;
	onDone: () => void;
}) {
	const { t } = useLingui();
	const approve = useApproveNode();
	const remove = useDeleteNode();
	const busy = approve.isPending || remove.isPending;
	const isApprove = action === "approve";
	const error = isApprove ? approve.error : remove.error;
	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={isApprove ? t`Approve node` : t`Reject node`}
			description={
				<>
					{isApprove ? <Trans>Approve</Trans> : <Trans>Reject and delete</Trans>}{" "}
					<strong>{node.hostname ?? node.name}</strong>
					{node.hostname !== null && node.hostname !== node.name && <> (named {node.name})</>}?
				</>
			}
			confirmLabel={isApprove ? t`Approve` : t`Reject`}
			destructive={!isApprove}
			busy={busy}
			onConfirm={() => {
				const mutation = isApprove ? approve : remove;
				mutation.mutate(node.id, {
					onSuccess: () => {
						toast.success(isApprove ? t`Node approved.` : t`Node rejected.`);
						onDone();
					},
					onError: (mutationFailure) => toast.error(mutationFailure.message),
				});
			}}
		>
			{isApprove && (
				<div className="grid gap-1 text-sm">
					<p>
						<Trans>
							Node key fingerprint: <code className="font-mono">{node.keyFingerprint ?? t`unknown`}</code>
						</Trans>
					</p>
					<p className="text-muted-foreground">
						<Trans>
							It must match what <code>crha enroll</code> printed, or <code>crha status</code> on the node, before you
							approve.
						</Trans>
					</p>
				</div>
			)}
			{error !== null && <ErrorState error={error} compact />}
		</ConfirmDialog>
	);
}

/**
 * Every node the user can see (doc/webui.md "Nodes"): status, connection,
 * clock warning, groups and access, plus approve/reject for pending nodes.
 * Enrollment and the SSH wizard are the two "Add" flows.
 */
export function NodesPage() {
	const { t } = useLingui();
	const user = useAuth().user;
	const nodes = useNodes();
	const [adding, setAdding] = useState(false);
	const [addingSsh, setAddingSsh] = useState(false);
	const [pending, setPending] = useState<{ node: PublicNode; action: "approve" | "reject" }>();

	const columns = useMemo<DataTableColumn<PublicNode>[]>(() => {
		const canDecide = (node: PublicNode) =>
			node.status === "pending" && (node.access === "owner" || user?.kind === "admin");
		return [
			{
				id: "name",
				header: t`Name`,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-2">
						<Link
							to="/nodes/$nodeId"
							params={{ nodeId: row.original.id }}
							className="truncate font-medium text-primary underline underline-offset-2"
						>
							{row.original.name}
						</Link>
						{row.original.transport === "ssh" && (
							<Badge variant="secondary">
								<Trans>SSH</Trans>
							</Badge>
						)}
					</span>
				),
			},
			{
				id: "status",
				header: t`Status`,
				size: 180,
				cell: ({ row }) => (
					<span className="flex items-center gap-1.5">
						<NodeStatusBadge status={row.original.status} connected={row.original.connected} />
						<ClockWarning warning={row.original.clockWarning} />
					</span>
				),
			},
			{
				id: "hostname",
				header: t`Hostname`,
				size: 160,
				cell: ({ row }) => <span className="truncate text-xs">{row.original.hostname ?? "–"}</span>,
			},
			{
				id: "os",
				header: t`OS`,
				size: 160,
				cell: ({ row }) => <span className="truncate text-xs">{osName(row.original.facts)}</span>,
			},
			{
				id: "groups",
				header: t`Groups`,
				size: 120,
				cell: ({ row }) => <span className="truncate text-xs">{row.original.groups.join(", ") || "–"}</span>,
			},
			{
				id: "access",
				header: t`Access`,
				size: 90,
				cell: ({ row }) => <span className="text-xs">{row.original.access}</span>,
			},
			{
				id: "lastSeen",
				header: t`Last seen`,
				size: 120,
				cell: ({ row }) => <RelativeTime value={row.original.lastSeenAt} className="text-xs" />,
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 130,
				cell: ({ row }) =>
					canDecide(row.original) ? (
						<span className="flex flex-nowrap items-center gap-1">
							<Button type="button" size="xs" onClick={() => setPending({ node: row.original, action: "approve" })}>
								<Trans>Approve</Trans>
							</Button>
							<Button
								type="button"
								size="xs"
								variant="destructive"
								onClick={() => setPending({ node: row.original, action: "reject" })}
							>
								<Trans>Reject</Trans>
							</Button>
						</span>
					) : null,
			},
		];
	}, [t, user?.kind]);

	return (
		<Page data-testid="nodes-page">
			<PageHeader
				title={<Trans>Nodes</Trans>}
				description={
					<Trans>
						Enrolled crha clients and SSH targets. Pending nodes need their key fingerprint checked before they can be
						used.
					</Trans>
				}
				actions={
					<>
						<Button type="button" variant="outline" onClick={() => void nodes.refetch()}>
							<RefreshCwIcon />
							<Trans>Refresh</Trans>
						</Button>
						<Button type="button" variant="outline" onClick={() => setAddingSsh(true)} data-testid="add-ssh-node">
							<Trans>Add SSH node</Trans>
						</Button>
						<Button type="button" onClick={() => setAdding(true)} data-testid="add-node">
							<PlusIcon />
							<Trans>Add node</Trans>
						</Button>
					</>
				}
			/>
			<DataTable
				label={t`Nodes`}
				columns={columns}
				data={nodes.data ?? []}
				getRowId={(node) => node.id}
				loading={nodes.isLoading}
				error={nodes.isError ? nodes.error : undefined}
				onRetry={() => void nodes.refetch()}
				empty={
					<EmptyState
						title={<Trans>No nodes yet</Trans>}
						description={<Trans>Use "Add node" to enrol a crha client, or "Add SSH node" for an SSH target.</Trans>}
					/>
				}
			/>
			{adding && <AddNodeDialog onClose={() => setAdding(false)} />}
			{addingSsh && <AddSshNodeDialog onClose={() => setAddingSsh(false)} />}
			{pending && (
				<PendingNodeDialog
					node={pending.node}
					action={pending.action}
					onClose={() => setPending(undefined)}
					onDone={() => {
						setPending(undefined);
						void nodes.refetch();
					}}
				/>
			)}
		</Page>
	);
}

function RenameNodeButton({ node }: { node: PublicNode }) {
	const { t } = useLingui();
	const prefix = useId();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(node.name);
	const rename = useRenameNode();
	return (
		<>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => {
					setName(node.name);
					setOpen(true);
				}}
			>
				<Trans>Rename</Trans>
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							<Trans>Rename node</Trans>
						</DialogTitle>
					</DialogHeader>
					<div className="grid gap-3">
						<FieldShell id={`${prefix}-name`} label={t`New name`}>
							<Input
								id={`${prefix}-name`}
								value={name}
								maxLength={200}
								onChange={(event) => setName(event.target.value)}
							/>
						</FieldShell>
						<ErrorState error={rename.error} compact />
						<div className="flex justify-end gap-2">
							<Button type="button" variant="outline" onClick={() => setOpen(false)}>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								type="button"
								disabled={rename.isPending || name.trim() === ""}
								onClick={() =>
									rename.mutate(
										{ id: node.id, name: name.trim() },
										{
											onSuccess: () => {
												toast.success(t`Node renamed.`);
												setOpen(false);
											},
											onError: (error) => toast.error(error.message),
										},
									)
								}
							>
								<Trans>Save</Trans>
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

function factValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** Sources the trust editor can build a snippet for: crhs's key and the user's own credentials. */
function useTrustSources(): TrustKeySource[] {
	const crhsKey = useCrhsKey();
	const credentials = useCredentials();
	return useMemo(() => {
		const sources: TrustKeySource[] = [];
		if (crhsKey.data) sources.push({ kind: "crhs", authorizedKey: crhsKey.data.authorizedKey });
		for (const credential of credentials.data ?? []) {
			if (credential.kind === "ssh") {
				sources.push({ kind: "ssh", name: credential.name, publicKey: credential.publicKey });
			} else {
				sources.push({
					kind: "webauthn",
					name: credential.name,
					rpId: credential.rpId ?? "",
					origins: credential.origins,
					credentialId: credential.credentialId ?? "",
					publicKey: credential.publicKey,
				});
			}
		}
		return sources;
	}, [crhsKey.data, credentials.data]);
}

/**
 * One node (doc/webui.md "Nodes"): identity, facts, the transport-specific
 * configuration, trust and signing keys, run panel, shares and recent tasks.
 */
export function NodeDetailPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { nodeId?: string };
	const id = params.nodeId ?? "";
	const node = useNode(id);
	const trustSources = useTrustSources();
	const details = node.data?.node;

	if (node.isError) {
		return (
			<div className="p-4">
				<ErrorState error={node.error} retry={() => void node.refetch()} />
			</div>
		);
	}
	if (!details) {
		return (
			<div className="p-4">
				<PageSkeleton />
			</div>
		);
	}

	const canRun = canRunOn(details);
	const manage = canManageNode(details);
	const facts = details.facts ? Object.entries(details.facts) : [];

	return (
		<Page width="detail" data-testid="node-detail">
			<div>
				<Link
					to="/nodes"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All nodes</Trans>
				</Link>
			</div>
			<PageHeader
				title={details.name}
				description={
					<span className="flex flex-wrap items-center gap-2">
						<NodeStatusBadge status={details.status} connected={details.connected} />
						{details.transport === "ssh" && (
							<Badge variant="secondary">
								<Trans>SSH</Trans>
							</Badge>
						)}
						<ClockWarning warning={details.clockWarning} />
					</span>
				}
				actions={manage ? <RenameNodeButton node={details} /> : undefined}
			/>

			<KeyValueList
				items={[
					{ label: t`Transport`, value: details.transport === "ssh" ? t`SSH` : t`crha client` },
					{ label: t`Hostname`, value: details.hostname ?? "–", mono: true },
					{ label: t`OS`, value: osName(details.facts) },
					{ label: t`Access`, value: details.access },
					{
						label: t`Privileged mode`,
						value: details.transport === "ssh" ? t`ignored (SSH)` : (details.privilegedMode ?? "–"),
					},
					{ label: t`Groups`, value: details.groups.join(", ") || "–" },
					...(details.transport === "client"
						? [
								{ label: t`Client`, value: details.clientVersion ?? "–" },
								{ label: t`Last seen`, value: <RelativeTime value={details.lastSeenAt} /> },
								{ label: t`Key fingerprint`, value: details.keyFingerprint ?? "–", mono: true },
							]
						: []),
					...(details.clockWarning !== null ? [{ label: t`Clock`, value: details.clockWarning }] : []),
					{ label: t`Node id`, value: details.id, mono: true },
				]}
			/>

			{facts.length > 0 && (
				<details className="rounded-lg border p-3">
					<summary className="cursor-pointer text-sm font-medium">
						<Trans>Facts ({facts.length})</Trans>
					</summary>
					<div className="mt-2">
						<KeyValueList items={facts.map(([key, value]) => ({ label: key, value: factValue(value), mono: true }))} />
					</div>
				</details>
			)}

			{details.transport === "ssh" && <SshNodeSection node={details} details={node.data?.ssh} canRun={canRun} />}
			{details.transport === "client" && (
				<>
					<NodeTrustPanel nodeId={details.id} />
					<section className="grid gap-2" aria-labelledby="trust-editor-heading">
						<h2 id="trust-editor-heading" className="text-sm font-semibold">
							<Trans>Trust configuration</Trans>
						</h2>
						<p className="max-w-3xl text-sm text-muted-foreground">
							<Trans>
								Build the `[[trust]]` block for this node's privileged.toml. The node enforces it; this page only
								exports it.
							</Trans>
						</p>
						{trustSources.length > 0 ? (
							<TrustEditor sources={trustSources} />
						) : (
							<p className="text-sm text-muted-foreground">
								<Trans>Add a signing credential or connect crhs before configuring trust.</Trans>
							</p>
						)}
					</section>
					{manage && <CrhsKeyPanel />}
				</>
			)}

			{canRun && <RunPanel nodeId={details.id} />}
			{node.data?.shares !== undefined && <NodeShares node={details} shares={node.data.shares} canManage={manage} />}
			<NodeTaskList nodeId={details.id} />
		</Page>
	);
}
