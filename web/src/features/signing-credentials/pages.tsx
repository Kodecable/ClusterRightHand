import type { SigningCredentialView } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { startRegistration } from "@simplewebauthn/browser";
import { FingerprintIcon, KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { CodeText } from "@/components/code-text";
import { CopyButton } from "@/components/copy-button";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { ErrorText } from "@/components/error-state";
import { TextareaField, TextField } from "@/components/form";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { Panel, SectionTitle } from "@/components/section";
import { useTimeColumnWidth } from "@/components/time-column";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, MONO_CELL } from "@/lib/utils";
import {
	useAddSshSigningCredential,
	useDeleteSigningCredential,
	usePasskeyOptions,
	useRegisterPasskey,
	useSigningCredentials,
} from "./api";
import { signingCredentialTrustSnippet } from "./trust";

interface SshFormValues {
	name: string;
	publicKey: string;
}

/** The key id a signing credential row shows: the SSH fingerprint or the WebAuthn credential id. */
export function signingCredentialKeyId(credential: SigningCredentialView): string {
	return credential.kind === "ssh" ? (credential.fingerprint ?? "") : (credential.credentialId ?? "");
}

function AddSshKeyForm() {
	const { t } = useLingui();
	const add = useAddSshSigningCredential();
	const schema = useMemo(
		() =>
			z.object({
				name: z.string().max(100, t`The name must be at most 100 characters.`),
				publicKey: z.string().trim().min(1, t`A public key is required.`),
			}),
		[t],
	);
	const form = useForm<SshFormValues>({ resolver: zodResolver(schema), defaultValues: { name: "", publicKey: "" } });
	return (
		<Panel className="grid gap-3">
			<SectionTitle>
				<Trans>Add an SSH key</Trans>
			</SectionTitle>
			<form
				className="grid gap-3"
				onSubmit={form.handleSubmit((values) => {
					add.mutate(
						{ publicKey: values.publicKey.trim(), name: values.name.trim() || undefined },
						{
							onSuccess: () => {
								form.reset();
							},
						},
					);
				})}
			>
				<TextField
					control={form.control}
					name="name"
					label={t`Name`}
					description={t`Optional; it names the trust entry.`}
				/>
				<TextareaField
					control={form.control}
					name="publicKey"
					label={t`Public key`}
					rows={3}
					placeholder="ssh-ed25519 AAAAC3Nza… you@laptop"
					description={t`One authorized_keys line: ssh-ed25519, sk-ssh-ed25519@openssh.com, ecdsa-sha2-nistp256 or sk-ecdsa-sha2-nistp256@openssh.com.`}
				/>
				<div>
					<Button type="submit" disabled={add.isPending}>
						<KeyRoundIcon />
						<Trans>Add SSH key</Trans>
					</Button>
				</div>
				<ErrorText error={add.error} />
			</form>
		</Panel>
	);
}

function AddPasskeyCard() {
	const { t } = useLingui();
	const options = usePasskeyOptions();
	const register = useRegisterPasskey();
	const [name, setName] = useState("");
	const [message, setMessage] = useState<string>();
	const busy = options.isPending || register.isPending;

	const add = async () => {
		setMessage(undefined);
		try {
			const { options: registrationOptions } = await options.mutateAsync();
			const response = await startRegistration({ optionsJSON: registrationOptions as never });
			await register.mutateAsync({ response, name: name.trim() || undefined });
			setName("");
		} catch (error) {
			if (error instanceof DOMException && error.name === "NotAllowedError") {
				setMessage(t`Passkey registration was cancelled.`);
				return;
			}
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<Panel className="grid gap-3">
			<SectionTitle>
				<Trans>Add a Passkey</Trans>
			</SectionTitle>
			<div className="grid gap-1.5">
				<Label htmlFor="passkey-name">{t`Name`}</Label>
				<Input
					id="passkey-name"
					value={name}
					maxLength={100}
					placeholder={t`Optional`}
					onChange={(event) => setName(event.target.value)}
				/>
			</div>
			<p className="text-sm text-muted-foreground">
				<Trans>
					The browser offers a platform authenticator (Touch ID, Windows Hello) or a security key. Only ES256, EdDSA and
					RS256 are requested, so a registered Passkey is one the node's privileged mode can verify.
				</Trans>
			</p>
			<div>
				<Button type="button" disabled={busy} onClick={() => void add()}>
					<FingerprintIcon />
					<Trans>Register Passkey</Trans>
				</Button>
			</div>
			<ErrorText error={message} />
		</Panel>
	);
}

function TrustSnippetDialog({ credential, onClose }: { credential: SigningCredentialView; onClose: () => void }) {
	const { t } = useLingui();
	const snippet = signingCredentialTrustSnippet(credential);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t`${credential.name}: privileged.toml`}</DialogTitle>
				</DialogHeader>
				<div className="max-h-[70vh] overflow-auto">
					<CodeText text={snippet} maxLines={60} label={t`Trust snippet`} copy={false} />
				</div>
				<DialogFooter className="justify-between sm:justify-between">
					<CopyButton text={snippet} label={t`Copy trust snippet`} showLabel variant="outline" />
					<Button type="button" variant="outline" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Signing credentials (doc/design/privilege.md "Signing methods"): the SSH keys and Passkeys that let this
 * user authorize privileged tasks on a node. Each row exports the `[[trust]]`
 * block to paste into that node's privileged.toml.
 */
export function SigningCredentialsPage() {
	const { t } = useLingui();
	const timeWidth = useTimeColumnWidth();
	const credentials = useSigningCredentials();
	const remove = useDeleteSigningCredential();
	const [snippet, setSnippet] = useState<SigningCredentialView>();
	const [deleting, setDeleting] = useState<SigningCredentialView>();

	const columns = useMemo<DataTableColumn<SigningCredentialView>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				minSize: 140,
				cell: ({ row }) => <span className="truncate font-medium">{row.original.name}</span>,
				meta: { title: (credential: SigningCredentialView) => credential.name },
			},
			{
				id: "kind",
				header: t`Kind`,
				size: 110,
				cell: ({ row }) => <span>{row.original.kind === "ssh" ? <Trans>SSH key</Trans> : <Trans>Passkey</Trans>}</span>,
			},
			{
				id: "key",
				header: t`Key`,
				cell: ({ row }) => {
					const key = signingCredentialKeyId(row.original);
					return (
						<span className={cn("block truncate", MONO_CELL)}>
							{key === "" ? <span className="text-muted-foreground">–</span> : key}
						</span>
					);
				},
				meta: { title: (credential: SigningCredentialView) => signingCredentialKeyId(credential) || undefined },
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
				size: 200,
				cell: ({ row }) => (
					<span className="flex flex-nowrap items-center gap-1">
						<Button type="button" size="xs" variant="outline" onClick={() => setSnippet(row.original)}>
							<Trans>Trust snippet</Trans>
						</Button>
						<Button
							type="button"
							size="xs"
							variant="destructive"
							aria-label={t`Delete ${row.original.name}`}
							onClick={() => setDeleting(row.original)}
						>
							<Trash2Icon />
							<Trans>Delete</Trans>
						</Button>
					</span>
				),
			},
		],
		[t, timeWidth],
	);

	return (
		<Page data-testid="signing-credentials-page">
			<PageHeader title={<Trans>Signing credentials</Trans>} />
			<div className="grid gap-4 lg:grid-cols-2">
				<AddSshKeyForm />
				<AddPasskeyCard />
			</div>
			<DataTable
				label={t`Signing credentials`}
				columns={columns}
				data={credentials.data ?? []}
				getRowId={(credential) => credential.id}
				loading={credentials.isLoading}
				error={credentials.isError ? credentials.error : undefined}
				onRetry={() => void credentials.refetch()}
				empty={
					<EmptyState
						bare
						title={<Trans>No signing credentials yet</Trans>}
						description={
							<Trans>Add an SSH key or register a Passkey to sign authorizations for privileged tasks.</Trans>
						}
					/>
				}
			/>
			{snippet && <TrustSnippetDialog credential={snippet} onClose={() => setSnippet(undefined)} />}
			<ConfirmDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleting(undefined);
				}}
				title={deleting ? t`Delete the signing credential "${deleting.name}"?` : ""}
				description={
					<Trans>
						Nodes that trust it stop accepting its signatures. Authorizations it already signed stay valid until their
						deadline.
					</Trans>
				}
				confirmLabel={<Trans>Delete signing credential</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.id, {
						onSuccess: () => {
							setDeleting(undefined);
						},
					});
				}}
			/>
		</Page>
	);
}
