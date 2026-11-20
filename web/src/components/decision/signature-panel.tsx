import type {
	ApprovalRequest,
	LocalWindowAuthorizationOption,
	NodeTrust,
	PendingAuthorization,
	PendingPasskey,
	PendingSignOption,
	ReusableScope,
} from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { startAuthentication } from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { ErrorText } from "@/components/error-state";
import { nodeTargetsText } from "@/components/node-targets";
import { DateTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { enc, errorMessage, http } from "@/lib/api/client";
import {
	grantCommand,
	reusableGrantCommand,
	SHORT_GRANT_SECONDS,
	signDraftWithPasskey,
	sshKeygenRecipe,
} from "@/lib/authorization";
import { type DecisionVariant, requestCardContent } from "./content";
import { DecisionCard, DecisionTab, DecisionTabList, DecisionTabs } from "./decision";
import { RejectDecision } from "./reject";

/** The pasted output of a signing recipe or a Passkey assertion, as the authorization endpoint takes it. */
export type SubmitSignature = { authorization: string } | { payload: string; webauthn: unknown };

/** The command a local administrator runs on the node to open a window (doc/design/privilege.md "Local approval window"). */
const LOCAL_WINDOW_COMMAND = "sudo crha approve --for 30m";

/** A one-line command with the copy button that puts the whole command on the clipboard. */
export function CommandLine({ text, label }: { text: string; label: string }) {
	return (
		<div className="flex min-w-0 items-center gap-2">
			<code
				data-testid="decision-command"
				title={text}
				className="block min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs leading-5"
			>
				{text}
			</code>
			<CopyButton text={text} label={label} showLabel />
		</div>
	);
}

/** The paste box both signing recipes submit through. */
export function PasteBox({
	value,
	disabled,
	onChange,
}: {
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
}) {
	const { t } = useLingui();
	const id = useId();
	return (
		<label className="grid gap-1 text-xs" htmlFor={id}>
			<span className="font-medium">{t`Signature`}</span>
			<Textarea
				id={id}
				rows={3}
				className="font-mono text-xs"
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
			/>
		</label>
	);
}

/** The node's last trust report, for the local window state; polled like the node trust panel. */
function useNodeTrustSummary(nodeId: string) {
	return useQuery({
		queryKey: ["node-trust", nodeId],
		queryFn: ({ signal }) =>
			http.get<{ trust: NodeTrust }>(`/nodes/${enc(nodeId)}/trust`, { signal }).then((r) => r.trust.summary),
		refetchInterval: 10_000,
	});
}

/** Whether the node trust view knows the window is open; absent while its query is loading or failed. */
function LocalWindowState({ option }: { option: LocalWindowAuthorizationOption }) {
	const summary = useNodeTrustSummary(option.nodeId);
	const window = summary.data?.localWindow;
	if (window?.kind === "open") {
		return (
			<p className="text-xs text-muted-foreground">
				<Trans>
					A local approval window is open on {option.nodeName} until{" "}
					<DateTime value={new Date(window.untilMs).toISOString()} />; crhs can run this task without a signature.
				</Trans>
			</p>
		);
	}
	return (
		<p className="text-xs text-muted-foreground">
			<Trans>
				Run this on {option.nodeName} as a user in its local trust entries. The window lets crhs run this task there
				without a signature; while it is open, crhs can run any privileged task on that node, including changing its
				trust configuration.
			</Trans>
		</p>
	);
}

/** The local-window options: one command block per node, with the window state when the trust view knows it. */
function LocalWindowOptions({ options }: { options: readonly LocalWindowAuthorizationOption[] }) {
	const { t } = useLingui();
	return (
		<div className="grid min-w-0 gap-3">
			{options.map((option) => (
				<div key={`${option.nodeId}`} className="grid min-w-0 gap-2">
					<CommandLine text={LOCAL_WINDOW_COMMAND} label={t`Copy command`} />
					<LocalWindowState option={option} />
				</div>
			))}
		</div>
	);
}

/**
 * What a 5-minute tab signs, in words: every task of the method on the request's nodes, the owner's other
 * sessions and scheduled runs included, so nobody takes it for a signature of this one task.
 */
function ShortGrantNote({ scope, request }: { scope: ReusableScope; request: ApprovalRequest }) {
	const { i18n } = useLingui();
	const nodes = nodeTargetsText(i18n, request.nodes ?? scope.nodes, request.moreNodes ?? 0);
	const method = scope.method;
	return (
		<p className="text-xs text-muted-foreground">
			<Trans>
				For 5 minutes, every {method} task of yours on {nodes} runs without asking for a signature, including tasks from
				your other sessions and scheduled runs.
			</Trans>
		</p>
	);
}

/** The sign option of a pending view; a group has one shared payload. */
function signOptionOf(pending: PendingAuthorization | undefined): PendingSignOption | undefined {
	return pending?.options.find((option): option is PendingSignOption => option.kind === "sign");
}

function windowOptionsOf(pending: PendingAuthorization | undefined): LocalWindowAuthorizationOption[] {
	return (pending?.options ?? []).filter(
		(option): option is LocalWindowAuthorizationOption => option.kind === "local_window",
	);
}

/**
 * A pending signature wait (doc/design/webui.md "Shared components"): the same compact ApprovalRequest and
 * card layout as an approval, then the options the server planned — a trusted Passkey, `crhu sign`, the
 * `ssh-keygen` recipe, a local approval window — and always Reject. When the request's nodes accept a
 * reusable prefix, the Passkey and crhu tabs each have a 5-minute twin that signs an empty prefix of the
 * request's method on its nodes instead of this one payload. A task whose plan is still being
 * written shows "Preparing…". The full command and recipe stay on one truncated line; the copy buttons
 * copy every character.
 */
export function SignaturePanel({
	request,
	variant = "inline",
	pending,
	pendingError,
	onSubmit,
	onChanged,
	onReject,
	busy = false,
	rejectBusy = false,
	error,
	rejectError,
	details,
	count,
	className,
}: {
	request: ApprovalRequest;
	variant?: DecisionVariant;
	/** Undefined while the server prepares the plan, or when the endpoint has no options yet. */
	pending?: PendingAuthorization;
	/** The options could not be read (for example by a viewer who may not sign). */
	pendingError?: unknown;
	onSubmit: (input: SubmitSignature) => Promise<unknown>;
	onChanged?: () => void;
	onReject: (reason: string) => void;
	busy?: boolean;
	rejectBusy?: boolean;
	error?: unknown;
	rejectError?: unknown;
	details?: ReactNode;
	count?: ReactNode;
	className?: string;
}) {
	const { t, i18n } = useLingui();
	const [pasted, setPasted] = useState("");
	const [working, setWorking] = useState(false);
	const [localError, setLocalError] = useState<string>();
	const [done, setDone] = useState<string>();
	// `crhu sign` until a Passkey is known to be trusted; then the Passkey tab is the default.
	const [tab, setTab] = useState("grant");
	const initialised = useRef(false);
	const sign = signOptionOf(pending);
	const windows = windowOptionsOf(pending);
	const awaitingNode = pending?.options.some((option) => option.kind === "awaiting_node") === true;
	useEffect(() => {
		if (pending === undefined || initialised.current) return;
		initialised.current = true;
		const plannedSign = signOptionOf(pending);
		if (plannedSign !== undefined) {
			setTab(plannedSign.payload.passkeys.length > 0 ? "passkey" : "grant");
		} else if (windowOptionsOf(pending).length > 0) {
			setTab("window");
		}
	}, [pending]);

	const disabled = busy || working;
	const passkeys = sign?.payload.passkeys ?? [];
	const content = requestCardContent(request, { variant, i18n });
	const ready = pending !== undefined && pending.options.length > 0;
	const scope = sign?.reusableScope ?? null;
	// Reject is always the first tab; the panel opens on the one after it.
	const tabs = [
		"reject",
		...(sign !== undefined && passkeys.length > 0 ? ["passkey"] : []),
		...(sign !== undefined && passkeys.length > 0 && scope !== null ? ["passkey5"] : []),
		...(sign !== undefined ? ["grant"] : []),
		...(sign !== undefined && scope !== null ? ["grant5"] : []),
		...(sign !== undefined ? ["keygen"] : []),
		...(windows.length > 0 ? ["window"] : []),
	];
	// A sync pass can remove the tab the owner had selected; fall back to the first way to decide after
	// Reject, so a vanished option never leaves the panel on Reject.
	const activeTab = tabs.includes(tab) ? tab : (tabs[1] ?? "reject");

	const submitPaste = async () => {
		if (pasted.trim() === "" || sign === undefined) return;
		setWorking(true);
		setLocalError(undefined);
		try {
			await onSubmit({ authorization: pasted.trim() });
			setPasted("");
			setDone(t`Authorization submitted.`);
			onChanged?.();
		} catch (caught) {
			setLocalError(errorMessage(caught));
		} finally {
			setWorking(false);
		}
	};

	const signPasskey = async (passkey: PendingPasskey) => {
		if (sign === undefined) return;
		const signedPayload = sign.payload.payload;
		setWorking(true);
		setLocalError(undefined);
		try {
			const response = await startAuthentication({
				optionsJSON: {
					rpId: passkey.rpId,
					challenge: sign.payload.challenge,
					allowCredentials: [{ id: passkey.credentialId, type: "public-key" }],
					userVerification: passkey.requireUv ? "required" : "preferred",
					timeout: 60_000,
				},
			});
			// The bytes this assertion signed: a payload refreshed meanwhile does not invalidate it.
			await onSubmit({ payload: signedPayload, webauthn: response });
			setDone(t`Signed with Passkey "${passkey.name}".`);
			onChanged?.();
		} catch (caught) {
			// DOMException NotAllowedError: the user dismissed the Passkey prompt.
			const cancelled = caught instanceof DOMException && caught.name === "NotAllowedError";
			setLocalError(cancelled ? t`Passkey signing was cancelled.` : errorMessage(caught));
		} finally {
			setWorking(false);
		}
	};

	/** Signs the 5-minute reusable authorization of this request's scope with one Passkey. */
	const signShortGrant = async (passkey: PendingPasskey) => {
		if (scope === null) return;
		setWorking(true);
		setLocalError(undefined);
		try {
			const signed = await signDraftWithPasskey(
				{ nodes: scope.nodes, command: { method: scope.method, prefix: "" }, ttlSeconds: SHORT_GRANT_SECONDS },
				passkey,
			);
			await onSubmit(signed);
			setDone(t`Signed with Passkey "${passkey.name}" for 5 minutes.`);
			onChanged?.();
		} catch (caught) {
			const cancelled = caught instanceof DOMException && caught.name === "NotAllowedError";
			setLocalError(cancelled ? t`Passkey signing was cancelled.` : errorMessage(caught));
		} finally {
			setWorking(false);
		}
	};

	const submitButton = (
		<div className="flex justify-end">
			<Button type="button" disabled={disabled || pasted.trim() === ""} onClick={() => void submitPaste()}>
				<Trans>Submit authorization</Trans>
			</Button>
		</div>
	);

	return (
		<DecisionCard {...content} kind="signature" variant={variant} count={count} details={details} className={className}>
			{pendingError !== undefined ? (
				<ErrorText error={pendingError} />
			) : (
				<>
					{!ready ? (
						<div className="grid gap-3">
							<p className="text-sm text-muted-foreground">
								<Trans>Preparing the payload to sign…</Trans>
							</p>
							<RejectDecision busy={rejectBusy} onReject={onReject} />
						</div>
					) : (
						<DecisionTabs value={activeTab} onValueChange={setTab}>
							{awaitingNode && (
								<p className="text-sm text-muted-foreground">
									<Trans>Signed. The task is sent when its node is back online.</Trans>
								</p>
							)}
							<DecisionTabList label={t`How to sign`}>
								<DecisionTab value="reject">
									<Trans>Reject</Trans>
								</DecisionTab>
								{sign !== undefined && passkeys.length > 0 && (
									<DecisionTab value="passkey">
										<Trans>Passkey</Trans>
									</DecisionTab>
								)}
								{sign !== undefined && passkeys.length > 0 && scope !== null && (
									<DecisionTab value="passkey5">
										<Trans>Passkey 5min</Trans>
									</DecisionTab>
								)}
								{sign !== undefined && <DecisionTab value="grant">crhu</DecisionTab>}
								{sign !== undefined && scope !== null && (
									<DecisionTab value="grant5">
										<Trans>crhu 5min</Trans>
									</DecisionTab>
								)}
								{sign !== undefined && <DecisionTab value="keygen">OpenSSH</DecisionTab>}
								{windows.length > 0 && (
									<DecisionTab value="window">
										<Trans>Local</Trans>
									</DecisionTab>
								)}
							</DecisionTabList>
							{sign !== undefined && passkeys.length > 0 && (
								<TabsContent value="passkey" className="grid min-w-0 gap-2 pt-1">
									<p className="text-xs text-muted-foreground">
										<Trans>Sign with a Passkey this node trusts for this command.</Trans>
									</p>
									<div className="flex flex-wrap justify-end gap-2">
										{passkeys.map((passkey) => (
											<Button
												key={`${passkey.credentialId}@${passkey.rpId}`}
												type="button"
												disabled={disabled}
												onClick={() => void signPasskey(passkey)}
											>
												<Trans>Sign with Passkey “{passkey.name}”</Trans>
											</Button>
										))}
									</div>
								</TabsContent>
							)}
							{sign !== undefined && passkeys.length > 0 && scope !== null && (
								<TabsContent value="passkey5" className="grid min-w-0 gap-2 pt-1">
									<ShortGrantNote scope={scope} request={request} />
									<div className="flex flex-wrap justify-end gap-2">
										{passkeys.map((passkey) => (
											<Button
												key={`${passkey.credentialId}@${passkey.rpId}`}
												type="button"
												disabled={disabled}
												onClick={() => void signShortGrant(passkey)}
											>
												<Trans>Sign with Passkey “{passkey.name}” for 5 minutes</Trans>
											</Button>
										))}
									</div>
								</TabsContent>
							)}
							{sign !== undefined && (
								<TabsContent value="grant" className="grid min-w-0 gap-2 pt-1">
									<CommandLine
										text={grantCommand(
											sign.payload.payload,
											sign.payload.decoded.command?.match === "spec" ? sign.payload.spec : undefined,
											sign.fingerprints ?? [],
										)}
										label={t`Copy command`}
									/>
									<PasteBox value={pasted} disabled={disabled} onChange={setPasted} />
									{submitButton}
								</TabsContent>
							)}
							{sign !== undefined && scope !== null && (
								<TabsContent value="grant5" className="grid min-w-0 gap-2 pt-1">
									<ShortGrantNote scope={scope} request={request} />
									<CommandLine
										text={reusableGrantCommand({
											nodes: scope.nodes,
											command: { method: scope.method, prefix: "" },
											deadline: "5m",
											fingerprints: sign.fingerprints ?? [],
										})}
										label={t`Copy command`}
									/>
									<PasteBox value={pasted} disabled={disabled} onChange={setPasted} />
									{submitButton}
								</TabsContent>
							)}
							{sign !== undefined && (
								<TabsContent value="keygen" className="grid min-w-0 gap-2 pt-1">
									<CommandLine text={sshKeygenRecipe(sign.payload.payload)} label={t`Copy command`} />
									<PasteBox value={pasted} disabled={disabled} onChange={setPasted} />
									{submitButton}
								</TabsContent>
							)}
							{windows.length > 0 && (
								<TabsContent value="window" className="grid min-w-0 gap-2 pt-1">
									<LocalWindowOptions options={windows} />
								</TabsContent>
							)}
							<TabsContent value="reject" className="min-w-0 pt-1">
								<RejectDecision busy={rejectBusy} onReject={onReject} />
							</TabsContent>
						</DecisionTabs>
					)}
					{localError !== undefined && <ErrorText error={localError} />}
					{error !== undefined && <ErrorText error={error} />}
					{rejectError !== undefined && <ErrorText error={rejectError} />}
					{done !== undefined && (
						<p role="status" className="text-sm text-ok">
							{done}
						</p>
					)}
				</>
			)}
		</DecisionCard>
	);
}
