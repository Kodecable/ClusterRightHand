import type { PendingAuthorization, PendingPasskey, TaskGroupPendingTask } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";
import { CodeText } from "@/components/code-text";
import { CopyButton } from "@/components/copy-button";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { ErrorText } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { Panel } from "@/components/section";
import { StatusText, taskStateLabel } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SubmitAuthorizationInput } from "@/features/authorizations/api";
import {
	authorizationLines,
	grantCommand,
	type PayloadLineKey,
	sshKeygenRecipe,
} from "@/features/authorizations/authorization";
import { errorMessage } from "@/lib/api/client";
import { useLocale } from "@/lib/i18n";
import { taskStatusTone } from "@/lib/status";
import { cn, MONO_CELL } from "@/lib/utils";

const LINE_LABELS: Record<PayloadLineKey, React.ReactNode> = {
	nodes: <Trans>Nodes</Trans>,
	command: <Trans>Command</Trans>,
	issued: <Trans>Issued</Trans>,
	deadline: <Trans>Deadline</Trans>,
	attempt: <Trans>Attempt</Trans>,
	tasks: <Trans>Tasks</Trans>,
	specHash: <Trans>Spec hash</Trans>,
	note: <Trans>Note</Trans>,
	authorizationId: <Trans>Authorization id</Trans>,
};

function TaskGroupTaskTable({ tasks }: { tasks: TaskGroupPendingTask[] }) {
	const { t, i18n } = useLingui();
	const columns: DataTableColumn<TaskGroupPendingTask>[] = [
		{ id: "node", header: t`Node`, minSize: 140, cell: ({ row }) => row.original.nodeName },
		{
			id: "task",
			header: t`Task`,
			size: 100,
			cell: ({ row }) => <span className={MONO_CELL}>{row.original.id.slice(0, 8)}…</span>,
			meta: { title: (task: TaskGroupPendingTask) => task.id },
		},
		{ id: "attempt", header: t`Attempt`, size: 80, cell: ({ row }) => row.original.attempt },
		{
			id: "state",
			header: t`Status`,
			size: 120,
			cell: ({ row }) => (
				<StatusText tone={taskStatusTone(row.original.state)}>{taskStateLabel(i18n, row.original.state)}</StatusText>
			),
		},
		{
			id: "rejection",
			header: t`Last rejection`,
			minSize: 160,
			cell: ({ row }) =>
				row.original.lastRejection ? (
					`${row.original.lastRejection.code}: ${row.original.lastRejection.message}`
				) : (
					<span className="text-muted-foreground">–</span>
				),
			meta: {
				title: (task: TaskGroupPendingTask) =>
					task.lastRejection ? `${task.lastRejection.code}: ${task.lastRejection.message}` : undefined,
			},
		},
	];
	return (
		<DataTable
			label={t`Tasks waiting for authorization`}
			columns={columns}
			data={tasks}
			getRowId={(task) => task.id}
			density="compact"
			frame={false}
		/>
	);
}

export interface AuthorizationCardProps {
	pending: PendingAuthorization;
	tasks?: TaskGroupPendingTask[];
	kind?: "task" | "task_group";
	/** Submit the pasted `crha grant` output or a Passkey assertion (the page's mutation). */
	onSubmit: (input: SubmitAuthorizationInput) => Promise<unknown>;
	/** Called after a successful submission so the page can refresh. */
	onChanged?: () => void;
	busy?: boolean;
	error?: unknown;
	className?: string;
}

/**
 * The waiting card of a task or task group whose owner has to sign the
 * payload (doc/design/privilege.md "Authorizations"): the decoded payload, a Passkey button per matching
 * credential, the `crha grant` command, the `ssh-keygen` recipe and a paste box.
 */
export function AuthorizationCard({
	pending,
	tasks = [],
	kind = "task",
	onSubmit,
	onChanged,
	busy = false,
	error,
	className,
}: AuthorizationCardProps) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const [pasted, setPasted] = useState("");
	const [working, setWorking] = useState(false);
	const [localError, setLocalError] = useState<string>();
	const [done, setDone] = useState<string>();

	const submitPaste = async () => {
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

	const disabled = busy || working;

	return (
		<Panel
			as="section"
			data-slot="authorization-card"
			aria-label={t`Waiting for your authorization`}
			className={cn("grid gap-3 bg-card text-card-foreground", className)}
		>
			<div className="grid gap-1">
				<h2 className="text-sm font-medium">
					<Trans>Waiting for your authorization</Trans>
				</h2>
				<p className="text-sm text-muted-foreground">
					<Trans>
						Sign the payload below with `crha grant` (or your Passkey). The signature is bound to this attempt: if the
						plan changes, this card shows a new payload.
					</Trans>
				</p>
			</div>

			{kind === "task_group" && tasks.length > 0 && <TaskGroupTaskTable tasks={tasks} />}

			<KeyValueList
				items={authorizationLines(pending, locale).map((line) => ({
					label: LINE_LABELS[line.key],
					value: line.key === "command" && line.value === "" ? <Trans>Any method and target</Trans> : line.value,
					mono: line.mono,
				}))}
			/>

			{pending.tried.length > 0 && (
				<p className="text-xs text-muted-foreground">
					<Trans>Already tried: {pending.tried.join(", ")}.</Trans>
				</p>
			)}
			{pending.lastRejection !== null && (
				<p className="text-xs text-danger">
					<Trans>
						Last rejection {pending.lastRejection.code} (attempt {pending.lastRejection.attempt}):{" "}
						{pending.lastRejection.message}
					</Trans>
				</p>
			)}

			{pending.passkeys.length > 0 ? (
				<div className="flex flex-wrap gap-2">
					{pending.passkeys.map((passkey) => (
						<Button
							key={`${passkey.credentialId}@${passkey.rpId}`}
							type="button"
							variant="default"
							disabled={disabled}
							onClick={() => void signPasskey(passkey)}
						>
							<Trans>Sign with Passkey “{passkey.name}”</Trans>
						</Button>
					))}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">
					<Trans>No Passkey of yours is trusted by this node for this command; sign with your SSH key below.</Trans>
				</p>
			)}

			<div className="grid gap-1">
				<div className="flex items-center justify-between gap-2">
					<h3 className="text-xs font-medium text-muted-foreground">
						<Trans>Sign on your workstation</Trans>
					</h3>
					<CopyButton text={grantCommand(pending.payload)} label={t`Copy crha grant command`} showLabel />
				</div>
				<CodeText text={grantCommand(pending.payload)} maxLines={0} copy={false} label={t`crha grant command`} />
				<p className="text-xs text-muted-foreground">
					<Trans>
						`crha grant` decodes the payload for confirmation, signs it with `ssh-keygen -Y sign -n crh-auth-v1` and
						prints the authorization to paste below. The same thing by hand:
					</Trans>
				</p>
				<div className="flex items-center justify-end">
					<CopyButton text={sshKeygenRecipe(pending.payload)} label={t`Copy ssh-keygen recipe`} showLabel />
				</div>
				<CodeText text={sshKeygenRecipe(pending.payload)} maxLines={0} copy={false} label={t`ssh-keygen recipe`} />
			</div>

			<label className="grid gap-1 text-xs font-medium" htmlFor="authorization-paste">
				<Trans>Authorization from `crha grant`</Trans>
				<Textarea
					id="authorization-paste"
					rows={3}
					className="font-mono text-xs"
					value={pasted}
					disabled={disabled}
					onChange={(event) => setPasted(event.target.value)}
				/>
			</label>

			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" disabled={disabled || pasted.trim() === ""} onClick={() => void submitPaste()}>
					<Trans>Submit authorization</Trans>
				</Button>
				{kind === "task" && pending.localRequested && (
					<p className="text-xs text-muted-foreground">
						<Trans>
							Or run <code className="font-mono">crha approve {pending.taskIds[0] ?? ""}</code> on the node (a user in
							its `local` trust entries) — the task then runs with that approval instead.
						</Trans>
					</p>
				)}
			</div>

			{localError !== undefined && <ErrorText error={localError} />}
			{error !== undefined && <ErrorText error={error} />}
			{done !== undefined && (
				<p role="status" className="text-sm text-ok">
					{done}
				</p>
			)}
		</Panel>
	);
}
