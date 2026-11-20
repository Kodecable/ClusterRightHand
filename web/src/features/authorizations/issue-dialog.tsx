import type { AuthorizationDraftBody, AuthorizationMethod, SigningCredentialView } from "@crh/api";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { CommandLine, PasteBox } from "@/components/decision/signature-panel";
import { EntityPicker } from "@/components/entity-picker";
import { ErrorText } from "@/components/error-state";
import { FieldShell } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogScrollArea,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSigningCredentials } from "@/features/signing-credentials/api";
import { errorMessage } from "@/lib/api/client";
import { type ReusableCommand, reusableGrantCommand, signDraftWithPasskey } from "@/lib/authorization";
import { useSubmitAuthorization } from "./api";

/** How long an issued authorization stays valid: the crhu `--deadline` duration and the same in seconds. */
const VALIDITY: readonly { key: string; seconds: number; label: MessageDescriptor }[] = [
	{ key: "5m", seconds: 5 * 60, label: msg`5 minutes` },
	{ key: "1h", seconds: 60 * 60, label: msg`1 hour` },
	{ key: "24h", seconds: 24 * 60 * 60, label: msg`1 day` },
	{ key: "168h", seconds: 7 * 24 * 60 * 60, label: msg`7 days` },
	{ key: "720h", seconds: 30 * 24 * 60 * 60, label: msg`30 days` },
	{ key: "2160h", seconds: 90 * 24 * 60 * 60, label: msg`90 days` },
	{ key: "8760h", seconds: 365 * 24 * 60 * 60, label: msg`365 days` },
];

const METHODS: readonly AuthorizationMethod[] = ["exec", "file.read", "file.write"];

/** The user's Passkeys that can sign: a Passkey without a relying party cannot produce an assertion. */
function signingPasskeys(credentials: readonly SigningCredentialView[] | undefined) {
	return (credentials ?? []).flatMap((credential) =>
		credential.kind === "webauthn" && credential.credentialId !== null && credential.rpId !== null
			? [{ id: credential.id, name: credential.name, credentialId: credential.credentialId, rpId: credential.rpId }]
			: [],
	);
}

/**
 * Issue authorization (doc/design/webui.md "Authorizations"): a reusable authorization for nodes or node
 * groups, limited to a method and target prefix or to any command, until a deadline. It is signed with one of
 * the user's Passkeys over a payload crhs drafts, or with `crhu grant`, whose printed line is pasted back.
 * Nothing is stored until a signed authorization is submitted.
 */
export function IssueAuthorizationDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t, i18n } = useLingui();
	const id = useId();
	const credentials = useSigningCredentials();
	const submit = useSubmitAuthorization();
	const [targets, setTargets] = useState<string[]>([]);
	const [limit, setLimit] = useState<"prefix" | "any">("prefix");
	const [method, setMethod] = useState<AuthorizationMethod>("exec");
	const [prefix, setPrefix] = useState("");
	const [validity, setValidity] = useState("24h");
	const [note, setNote] = useState("");
	const [pasted, setPasted] = useState("");
	const [working, setWorking] = useState(false);
	const [error, setError] = useState<string>();

	const passkeys = signingPasskeys(credentials.data);
	const [tab, setTab] = useState<string>();
	const activeTab = tab ?? (passkeys.length > 0 ? "passkey" : "crhu");
	const chosen = VALIDITY.find((entry) => entry.key === validity) ?? VALIDITY[2];
	const command: ReusableCommand = limit === "any" ? null : { method, prefix };
	const ready = targets.length > 0;
	const busy = working || submit.isPending;
	const body: AuthorizationDraftBody = {
		nodes: targets,
		command,
		ttlSeconds: chosen?.seconds ?? 24 * 60 * 60,
		...(note.trim() === "" ? {} : { note: note.trim() }),
	};
	const grant = reusableGrantCommand({
		nodes: targets,
		command,
		deadline: chosen?.key ?? "24h",
		note: note.trim(),
	});

	const finish = () => {
		setPasted("");
		setError(undefined);
		onOpenChange(false);
	};

	const signPasskey = async (passkey: (typeof passkeys)[number]) => {
		setWorking(true);
		setError(undefined);
		try {
			await submit.mutateAsync(await signDraftWithPasskey(body, passkey));
			finish();
		} catch (caught) {
			const cancelled = caught instanceof DOMException && caught.name === "NotAllowedError";
			setError(cancelled ? t`Passkey signing was cancelled.` : errorMessage(caught));
		} finally {
			setWorking(false);
		}
	};

	const submitPaste = async () => {
		setError(undefined);
		try {
			await submit.mutateAsync({ authorization: pasted.trim() });
			finish();
		} catch (caught) {
			setError(errorMessage(caught));
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
				data-testid="issue-authorization-dialog"
			>
				<DialogHeader className="border-b p-4">
					<DialogTitle>
						<Trans>Issue authorization</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							A reusable authorization lets matching privileged tasks of yours run on these nodes without asking for a
							signature until its deadline. It cannot be revoked here; keep the limit narrow and the deadline short.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<DialogScrollArea className="mx-0 my-0 grid flex-1 content-start gap-3 px-4 py-4">
					<FieldShell id={`${id}-targets`} label={t`Nodes or node groups`}>
						<EntityPicker
							id={`${id}-targets`}
							kind="nodeTarget"
							multiple
							label={t`Nodes or node groups`}
							value={targets}
							onChange={(ids) => setTargets(ids)}
							disabled={busy}
							className="w-full"
						/>
					</FieldShell>
					<div className="grid gap-3 sm:grid-cols-2">
						<FieldShell id={`${id}-limit`} label={t`Allows`}>
							<Select
								value={limit}
								onValueChange={(next) => {
									if (next === "prefix" || next === "any") setLimit(next);
								}}
								disabled={busy}
							>
								<SelectTrigger id={`${id}-limit`} className="w-full">
									<SelectValue>
										{(current: string | null) =>
											current === "any" ? <Trans>Any command</Trans> : <Trans>A method and target prefix</Trans>
										}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="prefix">
										<Trans>A method and target prefix</Trans>
									</SelectItem>
									<SelectItem value="any">
										<Trans>Any command</Trans>
									</SelectItem>
								</SelectContent>
							</Select>
						</FieldShell>
						<FieldShell id={`${id}-validity`} label={t`Valid for`}>
							<Select value={validity} onValueChange={(next) => setValidity(String(next))} disabled={busy}>
								<SelectTrigger id={`${id}-validity`} className="w-full">
									<SelectValue>
										{(current: string | null) => {
											const entry = VALIDITY.find((item) => item.key === current);
											return entry ? i18n._(entry.label) : null;
										}}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{VALIDITY.map((entry) => (
										<SelectItem key={entry.key} value={entry.key}>
											{i18n._(entry.label)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</FieldShell>
					</div>
					{limit === "prefix" ? (
						<div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
							<FieldShell id={`${id}-method`} label={t`Method`}>
								<Select
									value={method}
									onValueChange={(next) => {
										const found = METHODS.find((entry) => entry === next);
										if (found) setMethod(found);
									}}
									disabled={busy}
								>
									<SelectTrigger id={`${id}-method`} className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{METHODS.map((entry) => (
											<SelectItem key={entry} value={entry}>
												{entry}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</FieldShell>
							<FieldShell
								id={`${id}-prefix`}
								label={t`Target prefix`}
								description={
									<Trans>
										Matched character by character. Empty allows every target of the method; end a command prefix with a
										space and a directory with /.
									</Trans>
								}
							>
								<Input
									id={`${id}-prefix`}
									className="font-mono"
									value={prefix}
									disabled={busy}
									placeholder="systemctl restart "
									onChange={(event) => setPrefix(event.target.value)}
								/>
							</FieldShell>
						</div>
					) : (
						<p className="text-xs text-warn">
							<Trans>Any command allows every privileged task of yours on these nodes until the deadline.</Trans>
						</p>
					)}
					<FieldShell id={`${id}-note`} label={t`Note (optional)`}>
						<Input
							id={`${id}-note`}
							value={note}
							maxLength={500}
							disabled={busy}
							onChange={(event) => setNote(event.target.value)}
						/>
					</FieldShell>
					{!ready ? (
						<p className="text-xs text-muted-foreground">
							<Trans>Choose at least one node or node group to sign.</Trans>
						</p>
					) : (
						<Tabs value={activeTab} onValueChange={(next) => setTab(String(next))} className="min-w-0 gap-2">
							<TabsList variant="line" aria-label={t`How to sign`} className="w-full justify-start overflow-x-auto">
								{passkeys.length > 0 && (
									<TabsTrigger value="passkey" className="flex-none">
										<Trans>Passkey</Trans>
									</TabsTrigger>
								)}
								<TabsTrigger value="crhu" className="flex-none">
									crhu
								</TabsTrigger>
							</TabsList>
							{passkeys.length > 0 && (
								<TabsContent value="passkey" className="flex flex-wrap justify-end gap-2 pt-1">
									{passkeys.map((passkey) => (
										<Button key={passkey.id} type="button" disabled={busy} onClick={() => void signPasskey(passkey)}>
											<Trans>Sign with Passkey “{passkey.name}”</Trans>
										</Button>
									))}
								</TabsContent>
							)}
							<TabsContent value="crhu" className="grid min-w-0 gap-2 pt-1">
								<CommandLine text={grant} label={t`Copy command`} />
								<PasteBox value={pasted} disabled={busy} onChange={setPasted} />
								<div className="flex justify-end">
									<Button type="button" disabled={busy || pasted.trim() === ""} onClick={() => void submitPaste()}>
										<Trans>Submit authorization</Trans>
									</Button>
								</div>
							</TabsContent>
						</Tabs>
					)}
					{error !== undefined && <ErrorText error={error} />}
				</DialogScrollArea>
				<DialogFooter className="mx-0 mb-0 rounded-none">
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
						<Trans>Close</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
