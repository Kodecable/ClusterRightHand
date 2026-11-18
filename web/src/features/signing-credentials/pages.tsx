import type { SigningCredentialView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { startRegistration } from "@simplewebauthn/browser";
import { FingerprintIcon, KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { ErrorText } from "@/components/error-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { Panel, SectionTitle } from "@/components/section";
import { useTimeColumnWidth } from "@/components/time-column";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sshRegistrationCommand, sshRegistrationRecipe } from "@/lib/authorization";
import { signingCredentialKeyId } from "@/lib/signing-credential-key";
import { cn, MONO_CELL } from "@/lib/utils";
import {
	useDeleteSigningCredential,
	usePasskeyOptions,
	useRegisterPasskey,
	useRegisterSshSigningCredential,
	useSigningCredentials,
	useSshSigningChallenge,
} from "./api";
import { TrustConfigDialog } from "./trust-config-dialog";

/** A copyable multi-line recipe; the copy button copies every character. */
function Recipe({ text, label }: { text: string; label: string }) {
	return (
		<div className="grid min-w-0 gap-1.5">
			<pre className="min-w-0 overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 font-mono text-xs leading-5">
				{text}
			</pre>
			<CopyButton text={text} label={label} showLabel />
		</div>
	);
}

/**
 * SSH signing-credential registration (doc/design/privilege.md "Signing methods"): the server issues
 * a challenge, the user signs it with `crhu register` or `ssh-keygen`, and the signature proves the
 * private key is theirs. The public key is read from the signature, never pasted separately.
 */
function AddSshKeyForm() {
	const { t } = useLingui();
	const challenge = useSshSigningChallenge();
	const register = useRegisterSshSigningCredential();
	const [name, setName] = useState("");
	const [signature, setSignature] = useState("");
	const [message, setMessage] = useState<string>();
	const issued = challenge.data;
	const busy = challenge.isPending || register.isPending;

	const request = () => {
		setMessage(undefined);
		register.reset();
		challenge.mutate(undefined, {
			onError: (error) => setMessage(error instanceof Error ? error.message : String(error)),
		});
	};

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		setMessage(undefined);
		register.mutate(
			{ signature: signature.trim(), name: name.trim() || undefined },
			{
				onSuccess: () => {
					setSignature("");
					setName("");
					challenge.reset();
				},
				onError: (error) => {
					setMessage(error instanceof Error ? error.message : String(error));
					// Every submission spends the challenge server-side, so a retry needs a new one.
					challenge.reset();
				},
			},
		);
	};

	return (
		<Panel className="grid gap-3">
			<SectionTitle>
				<Trans>Register an SSH key</Trans>
			</SectionTitle>
			<p className="text-sm text-muted-foreground">
				<Trans>
					Sign a challenge with the SSH key. The signature proves you hold the private key, and the public key is read
					from it; encrypted keys, ssh-agent and FIDO keys work.
				</Trans>
			</p>
			<div>
				<Button type="button" disabled={busy} onClick={request}>
					<KeyRoundIcon />
					{issued ? <Trans>Request a new challenge</Trans> : <Trans>Request challenge</Trans>}
				</Button>
			</div>
			{issued !== undefined && (
				<>
					<p className="text-sm text-muted-foreground">
						<Trans>
							Expires <DateTime value={issued.expiresAt} />. Run this on your workstation and paste the output below:
						</Trans>
					</p>
					<Recipe text={sshRegistrationCommand(issued.challenge)} label={t`Copy command`} />
					<p className="text-sm text-muted-foreground">
						<Trans>Or sign the challenge by hand with ssh-keygen:</Trans>
					</p>
					<Recipe text={sshRegistrationRecipe(issued.challenge)} label={t`Copy command`} />
					<form className="grid gap-3" onSubmit={submit}>
						<label className="grid gap-1.5 text-sm" htmlFor="ssh-signing-name">
							<span className="font-medium">{t`Name`}</span>
							<Input
								id="ssh-signing-name"
								value={name}
								maxLength={100}
								placeholder={t`Optional`}
								onChange={(event) => setName(event.target.value)}
							/>
						</label>
						<label className="grid gap-1.5 text-sm" htmlFor="ssh-signing-signature">
							<span className="font-medium">{t`Signature`}</span>
							<Textarea
								id="ssh-signing-signature"
								rows={4}
								className="font-mono text-xs"
								value={signature}
								placeholder="-----BEGIN SSH SIGNATURE-----"
								onChange={(event) => setSignature(event.target.value)}
							/>
						</label>
						<div>
							<Button type="submit" disabled={busy || signature.trim() === ""}>
								<KeyRoundIcon />
								<Trans>Register SSH key</Trans>
							</Button>
						</div>
					</form>
				</>
			)}
			<ErrorText error={message ?? challenge.error ?? register.error} />
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

/**
 * Signing credentials (doc/design/privilege.md "Signing methods"): the SSH keys and Passkeys that let this
 * user authorize privileged tasks on a node. The page builds the `[[trust]]` entries for a node's
 * privileged.toml.
 */
export function SigningCredentialsPage() {
	const { t } = useLingui();
	const timeWidth = useTimeColumnWidth();
	const credentials = useSigningCredentials();
	const remove = useDeleteSigningCredential();
	const [generating, setGenerating] = useState(false);
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
				header: t`Key ID`,
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
						<CopyButton
							text={signingCredentialKeyId(row.original)}
							label={t`Copy key ID ${row.original.name}`}
							showLabel
							variant="outline"
						/>
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
			<PageHeader
				title={<Trans>Signing credentials</Trans>}
				actions={
					<Button type="button" onClick={() => setGenerating(true)}>
						<KeyRoundIcon />
						<Trans>Generate trust config</Trans>
					</Button>
				}
			/>
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
			<TrustConfigDialog open={generating} onOpenChange={setGenerating} />
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
