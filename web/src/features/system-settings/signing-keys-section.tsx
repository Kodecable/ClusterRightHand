import type { SigningKey, SigningKeyDeleteConflict, SigningKeyTrust } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyAndCloseButton, CopyButton } from "@/components/copy-button";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { TableEmpty } from "@/components/empty-state";
import { ErrorText } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { DateTime } from "@/components/relative-time";
import { SectionHeader } from "@/components/section";
import { useTimeColumnWidth } from "@/components/time-column";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { WarningBanner } from "@/components/warning-banner";
import { cn, linkClass, MONO_CELL } from "@/lib/utils";
import { signingKeyDeleteConflict, useCreateSigningKey, useDeleteSigningKey, useSigningKeys } from "./api";

/** How many trusting nodes a delete dialog links before it summarises the rest. */
const MAX_TRUSTED_NODE_LINKS = 3;

/**
 * The nodes behind a key's "Trusted by" count, for the delete dialog only: at most three links, then
 * an ellipsis and the remaining count. Each link truncates inside the dialog and keeps its full name in
 * the title.
 */
function TrustedNodeList({ nodes }: { nodes: readonly SigningKeyTrust[] }) {
	const shown = nodes.slice(0, MAX_TRUSTED_NODE_LINKS);
	return (
		<ul className="grid min-w-0 gap-1 text-sm" data-testid="signing-key-trusted-nodes">
			{shown.map((node) => (
				<li key={node.nodeId} className="flex min-w-0 items-baseline gap-1">
					<Link
						to="/nodes/$nodeId"
						params={{ nodeId: node.nodeId }}
						className={cn(linkClass, "min-w-0 truncate")}
						title={node.nodeName}
					>
						{node.nodeName}
					</Link>
					<span className="shrink-0 text-muted-foreground">({node.kinds.join(", ")})</span>
				</li>
			))}
			{nodes.length > shown.length && (
				<li className="flex min-w-0 items-center gap-1 text-muted-foreground">
					<span aria-hidden="true">…</span>
					<Plural value={nodes.length - shown.length} one="and # more" other="and # more" />
				</li>
			)}
		</ul>
	);
}

/** The dialog that shows a new key's authorized_keys line, for pasting into privileged.toml. */
function CreatedSigningKeyDialog({ signingKey, onClose }: { signingKey: SigningKey; onClose: () => void }) {
	const { t } = useLingui();
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-2xl" data-testid="signing-key-created" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>
						<Trans>Authorization signing key added</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Paste this line into the trust entry in a node's privileged.toml. The key is the newest, but a node uses
							it only after that node trusts it.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="grid min-w-0 gap-3">
					<KeyValueList items={[{ label: t`Fingerprint`, value: signingKey.fingerprint, mono: true }]} />
					<div className="grid min-w-0 gap-1.5">
						<p className="text-xs text-muted-foreground">{t`Public key`}</p>
						<code className={cn(MONO_CELL, "block min-w-0 rounded-lg border p-3 break-all [overflow-wrap:anywhere]")}>
							{signingKey.publicKey}
						</code>
					</div>
				</div>
				<DialogFooter>
					<CopyAndCloseButton text={signingKey.publicKey} onClose={onClose} />
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Confirms adding a key: there is nothing to fill in, because a key is identified by its fingerprint.
 * The creation request itself happens on confirm, and the caller opens the created-key dialog.
 */
function AddSigningKeyDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (signingKey: SigningKey) => void;
}) {
	const create = useCreateSigningKey();
	const [error, setError] = useState<unknown>();
	const add = async () => {
		setError(undefined);
		try {
			onCreated(await create.mutateAsync());
		} catch (failure) {
			// The dialog's error line shows the server's message.
			setError(failure);
		}
	};
	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Add authorization signing key</Trans>}
			description={
				<Trans>
					crhs generates a new ed25519 key. It becomes the newest key, but nodes use it only after their privileged.toml
					trusts it.
				</Trans>
			}
			confirmLabel={<Trans>Add authorization signing key</Trans>}
			destructive={false}
			busy={create.isPending}
			onConfirm={() => void add()}
		>
			<ErrorText error={error} />
		</ConfirmDialog>
	);
}

/**
 * crhs's authorization signing keys (doc/design/privilege.md "Authorization signing key"):
 * every key, the nodes whose trust report trusts it and the actions that add or
 * delete one. Keys are identified by fingerprint. The newest key is marked; crhs
 * signs new authorizations with it.
 */
export function SigningKeysSection() {
	const { t } = useLingui();
	const keys = useSigningKeys();
	const remove = useDeleteSigningKey();
	const [adding, setAdding] = useState(false);
	const [created, setCreated] = useState<SigningKey>();
	const [deleting, setDeleting] = useState<SigningKey>();
	const [conflict, setConflict] = useState<SigningKeyDeleteConflict>();
	const [deleteError, setDeleteError] = useState<unknown>();
	const timeWidth = useTimeColumnWidth();

	const deleteKey = async (force: boolean) => {
		if (deleting === undefined) return;
		setDeleteError(undefined);
		try {
			await remove.mutateAsync({ id: deleting.id, force });
			setDeleting(undefined);
			setConflict(undefined);
		} catch (failure) {
			const nodes = force ? null : signingKeyDeleteConflict(failure);
			if (nodes !== null) setConflict(nodes);
			else setDeleteError(failure);
		}
	};

	const isLastKey = keys.data?.length === 1;
	const trustedNodes = conflict?.nodes ?? deleting?.trustedBy ?? [];

	const columns = useMemo<DataTableColumn<SigningKey>[]>(
		() => [
			{
				id: "fingerprint",
				header: t`Fingerprint`,
				minSize: 260,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-2">
						<code className={cn(MONO_CELL, "min-w-0 truncate")}>{row.original.fingerprint}</code>
						{row.index === 0 && (
							<Badge variant="secondary" className="shrink-0">
								<Trans>Newest</Trans>
							</Badge>
						)}
						<CopyButton text={row.original.fingerprint} label={t`Copy fingerprint`} className="shrink-0" />
					</span>
				),
				meta: { title: (key: SigningKey) => key.fingerprint },
			},
			{
				id: "created",
				header: t`Created`,
				size: timeWidth,
				cell: ({ row }) => <DateTime value={row.original.createdAt} />,
			},
			{
				id: "trustedBy",
				header: t`Trusted by`,
				minSize: 100,
				cell: ({ row }) =>
					row.original.trustedBy.length === 0 ? (
						<span className="text-muted-foreground">
							<Trans>None</Trans>
						</span>
					) : (
						<Plural value={row.original.trustedBy.length} one="# node" other="# nodes" />
					),
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 120,
				cell: ({ row }) => (
					<Button
						type="button"
						variant="destructive"
						size="xs"
						aria-label={t`Delete authorization signing key ${row.original.fingerprint}`}
						onClick={() => {
							setDeleting(row.original);
							setConflict(undefined);
							setDeleteError(undefined);
						}}
					>
						<Trash2Icon />
						<Trans>Delete</Trans>
					</Button>
				),
			},
		],
		[t, timeWidth],
	);

	return (
		<section className="grid gap-3" aria-labelledby="signing-keys-heading" data-testid="signing-keys-section">
			<SectionHeader
				id="signing-keys-heading"
				title={<Trans>Authorization signing keys</Trans>}
				actions={
					<Button type="button" onClick={() => setAdding(true)} data-testid="add-signing-key">
						<PlusIcon />
						<Trans>Add authorization signing key</Trans>
					</Button>
				}
			/>
			<p className="text-sm text-muted-foreground">
				<Trans>
					Keys crhs signs authorizations with. The newest is used by default; a node trusts a key only when its
					privileged.toml lists it.
				</Trans>
			</p>
			<DataTable
				label={t`Authorization signing keys`}
				columns={columns}
				data={keys.data ?? []}
				getRowId={(key) => key.id}
				loading={keys.isLoading}
				error={keys.isError ? keys.error : undefined}
				onRetry={() => void keys.refetch()}
				empty={
					<TableEmpty>
						<Trans>No authorization signing keys yet. crhs cannot sign authorizations until one is added.</Trans>
					</TableEmpty>
				}
			/>
			{adding && (
				<AddSigningKeyDialog
					onClose={() => setAdding(false)}
					onCreated={(signingKey) => {
						setAdding(false);
						setCreated(signingKey);
					}}
				/>
			)}
			{created && <CreatedSigningKeyDialog signingKey={created} onClose={() => setCreated(undefined)} />}
			{deleting && (
				<ConfirmDialog
					open
					onOpenChange={(open) => {
						if (open) return;
						setDeleting(undefined);
						setConflict(undefined);
						setDeleteError(undefined);
					}}
					title={
						conflict === undefined ? (
							<Trans>Delete authorization signing key?</Trans>
						) : (
							<Trans>Authorization signing key still trusted</Trans>
						)
					}
					description={
						conflict === undefined ? undefined : (
							<Trans>
								These nodes still trust the key. Remove the entry from their privileged.toml and reload them, or delete
								it anyway.
							</Trans>
						)
					}
					confirmLabel={conflict === undefined ? <Trans>Delete</Trans> : <Trans>Delete anyway</Trans>}
					busy={remove.isPending}
					onConfirm={() => void deleteKey(conflict !== undefined)}
				>
					<div className="grid min-w-0 gap-3">
						<div className="grid min-w-0 gap-1">
							<p className="text-xs text-muted-foreground">
								<Trans>Fingerprint</Trans>
							</p>
							<code className={cn(MONO_CELL, "block min-w-0 rounded-lg border p-2 break-all [overflow-wrap:anywhere]")}>
								{deleting.fingerprint}
							</code>
						</div>
						{trustedNodes.length > 0 && (
							<div className="grid min-w-0 gap-1">
								<p className="text-xs text-muted-foreground">
									<Trans>Trusted by</Trans>
								</p>
								<TrustedNodeList nodes={trustedNodes} />
							</div>
						)}
						{isLastKey && (
							<WarningBanner icon>
								<Trans>This is the last authorization signing key: crhs will no longer sign for any node.</Trans>
							</WarningBanner>
						)}
						<ErrorText error={deleteError} />
					</div>
				</ConfirmDialog>
			)}
		</section>
	);
}
