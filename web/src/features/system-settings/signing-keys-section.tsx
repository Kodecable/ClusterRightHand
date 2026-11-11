import type { SigningKey, SigningKeyDeleteConflict } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { CopyButton } from "@/components/copy-button";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog, FormDialog } from "@/components/dialogs";
import { TableEmpty } from "@/components/empty-state";
import { ErrorText } from "@/components/error-state";
import { TextField } from "@/components/form";
import { KeyValueList } from "@/components/key-value";
import { DateTime } from "@/components/relative-time";
import { SectionHeader } from "@/components/section";
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
import { errorMessage } from "@/lib/api/client";
import { cn, linkClass, MONO_CELL } from "@/lib/utils";
import { signingKeyDeleteConflict, useCreateSigningKey, useDeleteSigningKey, useSigningKeys } from "./api";

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
			<DialogContent className="sm:max-w-2xl" data-testid="signing-key-created">
				<DialogHeader>
					<DialogTitle>
						<Trans>Signing key added</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Paste this line into the trust entry in a node's privileged.toml. The key is the newest, but a node uses
							it only after that node trusts it.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3">
					<KeyValueList
						items={[
							...(signingKey.name === null ? [] : [{ label: t`Name`, value: signingKey.name }]),
							{ label: t`Fingerprint`, value: signingKey.fingerprint, mono: true },
						]}
					/>
					<div className="grid gap-1.5">
						<p className="text-xs text-muted-foreground">{t`Public key`}</p>
						<code className={cn(MONO_CELL, "block rounded-lg border p-3 break-all [overflow-wrap:anywhere]")}>
							{signingKey.publicKey}
						</code>
					</div>
				</div>
				<DialogFooter>
					<CopyButton text={signingKey.publicKey} showLabel label={t`Copy public key`} variant="outline" />
					<Button type="button" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function AddSigningKeyDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (signingKey: SigningKey) => void;
}) {
	const { t } = useLingui();
	const create = useCreateSigningKey();
	const schema = useMemo(
		() => z.object({ name: z.string().max(100, t`The name must be at most 100 characters.`) }),
		[t],
	);
	type Values = z.infer<typeof schema>;
	const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: "" } });
	const submit = form.handleSubmit(async (values) => {
		const name = values.name.trim();
		try {
			onCreated(await create.mutateAsync(name === "" ? {} : { name }));
		} catch {
			// The dialog's error line shows the server's message.
		}
	});
	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Add signing key</Trans>}
			description={
				<Trans>
					crhs generates a new ed25519 key. It becomes the newest key, but nodes use it only after their privileged.toml
					trusts it.
				</Trans>
			}
			onSubmit={() => void submit()}
			submitLabel={<Trans>Add signing key</Trans>}
			busy={create.isPending}
			error={create.error === null ? undefined : errorMessage(create.error)}
			testId="add-signing-key-dialog"
		>
			<TextField
				control={form.control}
				name="name"
				label={<Trans>Name</Trans>}
				placeholder={t`Optional`}
				description={t`Optional, to tell keys apart in this list.`}
			/>
		</FormDialog>
	);
}

/**
 * crhs's authorization signing keys (doc/design/privilege.md "Authorization signing key"):
 * every key, the nodes whose trust report trusts it and the actions that add or
 * delete one. The newest key is marked; crhs signs new authorizations with it.
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
	const deleteName = deleting?.name ?? deleting?.fingerprint ?? "";

	const columns = useMemo<DataTableColumn<SigningKey>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				minSize: 140,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-2">
						<span className="truncate">
							{row.original.name ?? <span className="text-muted-foreground">{t`Unnamed`}</span>}
						</span>
						{row.index === 0 && (
							<Badge variant="secondary">
								<Trans>Newest</Trans>
							</Badge>
						)}
					</span>
				),
				meta: { title: (key: SigningKey) => key.name ?? t`Unnamed` },
			},
			{
				id: "fingerprint",
				header: t`Fingerprint`,
				minSize: 220,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-1">
						<code className={cn(MONO_CELL, "truncate")}>{row.original.fingerprint}</code>
						<CopyButton text={row.original.fingerprint} label={t`Copy fingerprint`} />
					</span>
				),
				meta: { title: (key: SigningKey) => key.fingerprint },
			},
			{
				id: "created",
				header: t`Created`,
				size: 170,
				cell: ({ row }) => <DateTime value={row.original.createdAt} />,
			},
			{
				id: "trustedBy",
				header: t`Trusted by`,
				minSize: 180,
				cell: ({ row }) =>
					row.original.trustedBy.length === 0 ? (
						<span className="text-muted-foreground">
							<Trans>No node trusts it</Trans>
						</span>
					) : (
						<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
							{row.original.trustedBy.map((trust, index) => (
								<span key={trust.nodeId} className="inline-flex items-center gap-1">
									{index > 0 && <span className="text-muted-foreground">,</span>}
									<Link
										to="/nodes/$nodeId"
										params={{ nodeId: trust.nodeId }}
										className={linkClass}
										title={trust.kinds.join(", ")}
									>
										{trust.nodeName}
									</Link>
								</span>
							))}
						</span>
					),
				meta: {
					title: (key: SigningKey) =>
						key.trustedBy.length === 0 ? undefined : key.trustedBy.map((trust) => trust.nodeName).join(", "),
				},
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
						aria-label={t`Delete signing key ${row.original.name ?? row.original.fingerprint}`}
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
		[t],
	);

	return (
		<section className="grid gap-3" aria-labelledby="signing-keys-heading" data-testid="signing-keys-section">
			<SectionHeader
				id="signing-keys-heading"
				title={<Trans>Signing keys</Trans>}
				actions={
					<Button type="button" onClick={() => setAdding(true)} data-testid="add-signing-key">
						<PlusIcon />
						<Trans>Add signing key</Trans>
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
				label={t`Signing keys`}
				columns={columns}
				data={keys.data ?? []}
				getRowId={(key) => key.id}
				loading={keys.isLoading}
				error={keys.isError ? keys.error : undefined}
				onRetry={() => void keys.refetch()}
				empty={
					<TableEmpty>
						<Trans>No signing keys yet. crhs cannot sign authorizations until one is added.</Trans>
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
					title={conflict === undefined ? <Trans>Delete signing key?</Trans> : <Trans>Key still trusted</Trans>}
					description={
						conflict === undefined ? (
							<Trans>Delete the signing key {deleteName}?</Trans>
						) : (
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
					{conflict !== undefined && (
						<ul className="grid gap-1 text-sm" data-testid="signing-key-trusted-nodes">
							{conflict.nodes.map((node) => (
								<li key={node.nodeId}>
									<Link to="/nodes/$nodeId" params={{ nodeId: node.nodeId }} className={linkClass}>
										{node.nodeName}
									</Link>
									<span className="text-muted-foreground"> ({node.kinds.join(", ")})</span>
								</li>
							))}
						</ul>
					)}
					{isLastKey && (
						<WarningBanner icon>
							<Trans>This is the last signing key: crhs will no longer sign for any node.</Trans>
						</WarningBanner>
					)}
					<ErrorText error={deleteError} />
				</ConfirmDialog>
			)}
		</section>
	);
}
