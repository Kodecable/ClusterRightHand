import type { PendingAuthorization, PendingPasskey } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { startAuthentication } from "@simplewebauthn/browser";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import {
	DecisionFrame,
	DecisionTab,
	DecisionTabList,
	DecisionTabs,
	PrivilegedMark,
} from "@/components/decision/decision";
import { RejectDecision } from "@/components/decision/reject";
import { DecisionSummary, operationText } from "@/components/decision/summary";
import type { ApprovalItem } from "@/components/decision/types";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api/client";
import type { SubmitAuthorizationInput } from "./api";
import { grantCommand, sshKeygenRecipe } from "./authorization";

/** A one-line command with the copy button that puts the whole command on the clipboard. */
function CommandLine({ text, label }: { text: string; label: string }) {
	return (
		<div className="flex min-w-0 items-center gap-2">
			<code
				data-testid="decision-command"
				title={text}
				className="block min-w-0 flex-1 truncate rounded bg-[var(--code)] px-2 py-1 font-mono text-xs leading-5"
			>
				{text}
			</code>
			<CopyButton text={text} label={label} showLabel />
		</div>
	);
}

/** The paste box both signing recipes submit through. */
function PasteBox({
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
		<label className="grid gap-1 text-xs font-medium" htmlFor={id}>
			{t`Signature`}
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

/**
 * A pending signature wait (doc/design/webui.md "Shared components"): the target nodes and the
 * operation, then how to sign it — a trusted Passkey, `crha grant`, the
 * `ssh-keygen` recipe, a local `crha approve`, or Reject. The full command and
 * recipe stay on one truncated line; the copy buttons copy every character.
 */
export function SignatureDecision({
	item,
	pending,
	pendingError,
	nodeNames = new Map(),
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
	item: ApprovalItem;
	/** Undefined while the server prepares the payload. */
	pending?: PendingAuthorization;
	/** The pending payload could not be read (for example by a viewer who may not sign). */
	pendingError?: unknown;
	nodeNames?: Map<string, string>;
	onSubmit: (input: SubmitAuthorizationInput) => Promise<unknown>;
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
	const { t } = useLingui();
	const [pasted, setPasted] = useState("");
	const [working, setWorking] = useState(false);
	const [localError, setLocalError] = useState<string>();
	const [done, setDone] = useState<string>();
	// `crha grant` until a Passkey is known to be trusted; then the Passkey tab is the default.
	const [tab, setTab] = useState("grant");
	const initialised = useRef(false);
	useEffect(() => {
		if (pending === undefined || initialised.current) return;
		initialised.current = true;
		if (pending.passkeys.length > 0) setTab("passkey");
	}, [pending]);

	const disabled = busy || working;
	const passkeys = pending?.passkeys ?? [];
	const localAvailable = pending?.localRequested === true && item.kind === "task";
	const localTaskId = pending?.taskIds[0] ?? (item.kind === "task" ? item.task.id : "");
	const localCommand = `crha approve ${localTaskId}`;
	const subject = item.kind === "task" ? item.task : item.taskGroup;
	const ids = item.kind === "task" ? [item.task.nodeId] : item.taskGroup.targets;

	const submitPaste = async () => {
		if (pasted.trim() === "") return;
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
		if (pending === undefined) return;
		setWorking(true);
		setLocalError(undefined);
		try {
			const response = await startAuthentication({
				optionsJSON: {
					rpId: passkey.rpId,
					challenge: pending.challenge,
					allowCredentials: [{ id: passkey.credentialId, type: "public-key" }],
					userVerification: passkey.requireUv ? "required" : "preferred",
					timeout: 60_000,
				},
			});
			await onSubmit({ payloadId: pending.id, webauthn: response });
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

	const submitButton = (
		<div className="flex justify-end">
			<Button type="button" disabled={disabled || pasted.trim() === ""} onClick={() => void submitPaste()}>
				<Trans>Submit authorization</Trans>
			</Button>
		</div>
	);

	return (
		<DecisionFrame
			kind="signature"
			title={t`Sign to approve`}
			badge={subject.privileged ? <PrivilegedMark /> : undefined}
			summary={
				<DecisionSummary
					ids={ids}
					refs={item.kind === "task_group" ? item.taskGroup.refs : undefined}
					nodeNames={nodeNames}
					operation={operationText(subject.kind, subject.operation, subject.summary)}
				/>
			}
			details={details}
			count={count}
			className={className}
		>
			{pendingError !== undefined ? (
				<ErrorText error={pendingError} />
			) : (
				<>
					<DecisionTabs value={tab} onValueChange={setTab}>
						<DecisionTabList label={t`How to sign`}>
							{passkeys.length > 0 && (
								<DecisionTab value="passkey">
									<Trans>Passkey</Trans>
								</DecisionTab>
							)}
							<DecisionTab value="grant">crha grant</DecisionTab>
							<DecisionTab value="keygen">ssh-keygen</DecisionTab>
							{localAvailable && (
								<DecisionTab value="local">
									<Trans>Local approval</Trans>
								</DecisionTab>
							)}
							<DecisionTab value="reject">
								<Trans>Reject</Trans>
							</DecisionTab>
						</DecisionTabList>
						{passkeys.length > 0 && (
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
						<TabsContent value="grant" className="grid min-w-0 gap-2 pt-1">
							{pending === undefined ? (
								<p className="text-sm text-muted-foreground">
									<Trans>Preparing the payload to sign…</Trans>
								</p>
							) : (
								<>
									<CommandLine text={grantCommand(pending.payload)} label={t`Copy command`} />
									<PasteBox value={pasted} disabled={disabled} onChange={setPasted} />
									{submitButton}
								</>
							)}
						</TabsContent>
						<TabsContent value="keygen" className="grid min-w-0 gap-2 pt-1">
							{pending === undefined ? (
								<p className="text-sm text-muted-foreground">
									<Trans>Preparing the payload to sign…</Trans>
								</p>
							) : (
								<>
									<CommandLine text={sshKeygenRecipe(pending.payload)} label={t`Copy command`} />
									<PasteBox value={pasted} disabled={disabled} onChange={setPasted} />
									{submitButton}
								</>
							)}
						</TabsContent>
						{localAvailable && (
							<TabsContent value="local" className="grid min-w-0 gap-2 pt-1">
								<CommandLine text={localCommand} label={t`Copy command`} />
								<p className="text-xs text-muted-foreground">
									<Trans>
										Run this on the node as a user in its local trust entries; the task then runs with that approval
										instead.
									</Trans>
								</p>
							</TabsContent>
						)}
						<TabsContent value="reject" className="min-w-0 pt-1">
							<RejectDecision busy={rejectBusy} onReject={onReject} />
						</TabsContent>
					</DecisionTabs>
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
		</DecisionFrame>
	);
}
