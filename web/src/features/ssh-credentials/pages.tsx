import type { SshCredential } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { LockKeyholeIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Fragment, useId, useMemo, useState } from "react";
import { CodeText } from "@/components/code-text";
import { CopyAndCloseButton, CopyButton } from "@/components/copy-button";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog, FormDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { ErrorText } from "@/components/error-state";
import { FieldShell } from "@/components/form";
import { NodeLink } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { useTimeColumnWidth } from "@/components/time-column";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/session";
import { errorMessage } from "@/lib/api/client";
import { cn, MONO_CELL } from "@/lib/utils";
import { useCreateSshCredential, useDeleteSshCredential, useSshCredentials } from "./api";

/** The public key as one truncated line; the full authorized_keys line is in the title and the copy button. */
function truncatedKey(publicKey: string): string {
	return publicKey.length <= 48 ? publicKey : `${publicKey.slice(0, 45)}…`;
}

function UsedBy({ credential }: { credential: SshCredential }) {
	if (credential.usedBy.length === 0) {
		return <span className="text-muted-foreground">–</span>;
	}
	return (
		<span className="flex flex-wrap items-center gap-x-1">
			{credential.usedBy.map((node, index) => (
				<Fragment key={node.id}>
					{index > 0 && <span className="text-muted-foreground">,</span>}
					<NodeLink id={node.id} name={node.name} />
				</Fragment>
			))}
		</span>
	);
}

function CreateCredentialDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (credential: SshCredential) => void;
}) {
	const { t } = useLingui();
	const create = useCreateSshCredential();
	const [name, setName] = useState("");
	const id = useId();

	const close = () => {
		if (create.isPending) return;
		create.reset();
		setName("");
		onOpenChange(false);
	};

	return (
		<FormDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) close();
			}}
			title={<Trans>New SSH credential</Trans>}
			description={
				<Trans>
					crhs generates an ed25519 key pair and keeps the private half. Only its public key leaves the server.
				</Trans>
			}
			onSubmit={() => {
				create.mutate(name.trim(), {
					onSuccess: (credential) => {
						create.reset();
						setName("");
						onOpenChange(false);
						onCreated(credential);
					},
				});
			}}
			submitLabel={<Trans>New SSH credential</Trans>}
			busy={create.isPending}
			submitDisabled={name.trim() === ""}
			error={create.error ? errorMessage(create.error) : undefined}
			testId="ssh-credential-create-dialog"
		>
			<FieldShell id={id} label={t`Name`} description={t`A label for this key, for example "laptop".`}>
				<Input id={id} value={name} maxLength={100} autoFocus onChange={(event) => setName(event.target.value)} />
			</FieldShell>
		</FormDialog>
	);
}

function CreatedCredentialDialog({ credential, onClose }: { credential: SshCredential; onClose: () => void }) {
	const { t } = useLingui();
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent data-testid="ssh-credential-created-dialog" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>
						<Trans>SSH credential created</Trans>
					</DialogTitle>
				</DialogHeader>
				<CodeText text={credential.publicKey} maxLines={4} label={t`Public key`} copy={false} />
				<DialogFooter>
					<CopyAndCloseButton text={credential.publicKey} onClose={onClose} />
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function SshCredentialsAdminPage() {
	const { t } = useLingui();
	const timeWidth = useTimeColumnWidth();
	const credentials = useSshCredentials();
	const remove = useDeleteSshCredential();
	const [creating, setCreating] = useState(false);
	const [created, setCreated] = useState<SshCredential>();
	const [deleting, setDeleting] = useState<SshCredential>();

	const columns = useMemo<DataTableColumn<SshCredential>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				minSize: 140,
				cell: ({ row }) => <span className="truncate font-medium">{row.original.name}</span>,
				meta: { title: (credential: SshCredential) => credential.name },
			},
			{
				id: "publicKey",
				header: t`Public key`,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-1">
						<code className={cn("truncate", MONO_CELL)} title={row.original.publicKey}>
							{truncatedKey(row.original.publicKey)}
						</code>
						<CopyButton text={row.original.publicKey} label={t`Copy public key`} size="icon-xs" />
					</span>
				),
			},
			{
				id: "created",
				header: t`Created`,
				size: timeWidth,
				cell: ({ row }) => <DateTime value={row.original.createdAt} />,
			},
			{
				id: "usedBy",
				header: t`Used by`,
				minSize: 140,
				cell: ({ row }) => <UsedBy credential={row.original} />,
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 110,
				cell: ({ row }) => {
					const used = row.original.usedBy.length > 0;
					return (
						<span title={used ? t`This credential is used by a node and cannot be deleted.` : undefined}>
							<Button
								type="button"
								size="xs"
								variant="destructive"
								disabled={used}
								title={
									used ? t`This credential is used by a node and cannot be deleted.` : t`Delete ${row.original.name}`
								}
								aria-label={t`Delete ${row.original.name}`}
								onClick={() => {
									remove.reset();
									setDeleting(row.original);
								}}
							>
								<Trash2Icon />
								<Trans>Delete</Trans>
							</Button>
						</span>
					);
				},
			},
		],
		[t, remove, timeWidth],
	);

	return (
		<Page data-testid="ssh-credentials-page">
			<PageHeader
				title={<Trans>SSH credentials</Trans>}
				description={
					<Trans>Organization-owned SSH keys that crhs uses to reach nodes. Only administrators can manage them.</Trans>
				}
				actions={
					<Button type="button" onClick={() => setCreating(true)}>
						<PlusIcon />
						<Trans>New SSH credential</Trans>
					</Button>
				}
			/>
			<DataTable
				label={t`SSH credentials`}
				columns={columns}
				data={credentials.data ?? []}
				getRowId={(credential) => credential.id}
				loading={credentials.isLoading}
				error={credentials.isError ? credentials.error : undefined}
				onRetry={() => void credentials.refetch()}
				empty={
					<EmptyState
						bare
						icon={<LockKeyholeIcon className="size-6" />}
						title={<Trans>No SSH credentials yet</Trans>}
						description={<Trans>Create one to give crhs a key for SSH nodes and jump hosts.</Trans>}
					/>
				}
			/>
			<CreateCredentialDialog open={creating} onOpenChange={setCreating} onCreated={setCreated} />
			{created && <CreatedCredentialDialog credential={created} onClose={() => setCreated(undefined)} />}
			<ConfirmDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (open || remove.isPending) return;
					remove.reset();
					setDeleting(undefined);
				}}
				title={deleting ? t`Delete the SSH credential "${deleting.name}"?` : ""}
				description={<Trans>The credential and its private key are deleted. This cannot be undone.</Trans>}
				confirmLabel={<Trans>Delete credential</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.id, {
						onSuccess: () => {
							setDeleting(undefined);
						},
					});
				}}
			>
				<ErrorText error={remove.error} />
			</ConfirmDialog>
		</Page>
	);
}

function NotAllowed() {
	return (
		<Page data-testid="ssh-credentials-page">
			<PageHeader title={<Trans>SSH credentials</Trans>} />
			<div data-testid="ssh-credentials-not-allowed">
				<EmptyState
					icon={<LockKeyholeIcon className="size-6" />}
					title={<Trans>Administrators only</Trans>}
					description={<Trans>Only administrators can manage SSH credentials.</Trans>}
				/>
			</div>
		</Page>
	);
}

/** Organization-owned SSH credentials and their users; administrators only. */
export function SshCredentialsPage() {
	const user = useAuth().user;
	if (user?.kind !== "admin") return <NotAllowed />;
	return <SshCredentialsAdminPage />;
}
