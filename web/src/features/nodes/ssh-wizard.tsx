import type { PublicNode } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { CodeText } from "@/components/code-text";
import { CopyButton } from "@/components/copy-button";
import { ErrorText } from "@/components/error-state";
import { FieldShell } from "@/components/form";
import { KeyValueList } from "@/components/key-value";
import { Spinner } from "@/components/spinner";
import { TestConnection } from "@/components/test-connection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateSshNode, useProbeSshHost, useTestSshRoute } from "@/features/nodes/api";
import { useCreateSshCredential, useSshCredentials } from "@/features/ssh-credentials/api";
import {
	addJump,
	editHop,
	emptyHop,
	firstUnpinned,
	type Hop,
	type HopError,
	hopBodies,
	moveJump,
	pinHop,
	removeJump,
	validateHops,
} from "./sshHops";

/** The wizard's four steps, in order (doc/webui.md "Nodes" / the SSH wizard). */
export const SSH_STEP_LABELS: readonly MessageDescriptor[] = [
	msg`Credential`,
	msg`Target`,
	msg`Host keys`,
	msg`Create`,
];

const HOP_ERRORS: Record<HopError["code"], MessageDescriptor> = {
	"host-required": msg`A host is required.`,
	"user-required": msg`A user is required.`,
	"port-invalid": msg`The port must be between 1 and 65535.`,
};

/** "target" or "jump host N", for messages in the wizard. */
function hopName(i18n: I18n, hops: Hop[], index: number): string {
	return index === hops.length - 1 ? i18n._(msg`Target`) : i18n._(msg`Jump host {index}`.id, { index: index + 1 });
}

/** The translated description of a hop validation failure. */
export function hopErrorText(i18n: I18n, hops: Hop[], error: HopError): string {
	return `${hopName(i18n, hops, error.hop)}: ${i18n._(HOP_ERRORS[error.code])}`;
}

/** Wizard step 1: choose or create the SSH credential whose public key goes into authorized_keys. */
function CredentialStep({
	value,
	onChange,
	onReadyChange,
}: {
	value: string;
	onChange: (id: string) => void;
	onReadyChange: (ready: boolean) => void;
}) {
	const { t } = useLingui();
	const credentials = useSshCredentials();
	const create = useCreateSshCredential();
	const [name, setName] = useState("");
	const prefix = useId();
	const current = credentials.data?.find((credential) => credential.id === value);

	return (
		<div className="grid gap-3" data-testid="ssh-step-credential">
			{credentials.isLoading && <Spinner />}
			<ErrorText error={credentials.isError ? credentials.error : undefined} />
			{credentials.data && credentials.data.length > 0 && (
				<div className="grid gap-1.5">
					<Label htmlFor={`${prefix}-credential`}>{t`SSH credential`}</Label>
					<Select
						value={value === "" ? null : value}
						onValueChange={(next) => {
							const id = typeof next === "string" ? next : "";
							onChange(id);
							onReadyChange(id !== "");
						}}
					>
						<SelectTrigger id={`${prefix}-credential`} className="w-full">
							<SelectValue placeholder={t`Select…`}>
								{(selected: string | null) =>
									credentials.data?.find((credential) => credential.id === selected)?.name ?? t`Select…`
								}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{credentials.data.map((credential) => (
								<SelectItem key={credential.id} value={credential.id}>
									{credential.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}
			<div className="flex flex-wrap items-end gap-2">
				<FieldShell id={`${prefix}-new-name`} label={t`New credential name`} className="min-w-56 flex-1">
					<Input
						id={`${prefix}-new-name`}
						value={name}
						maxLength={100}
						onChange={(event) => setName(event.target.value)}
					/>
				</FieldShell>
				<Button
					type="button"
					variant="outline"
					disabled={create.isPending || name.trim() === ""}
					onClick={() => {
						create.mutate(name.trim(), {
							onSuccess: (credential) => {
								setName("");
								onChange(credential.id);
								onReadyChange(true);
							},
						});
					}}
				>
					<PlusIcon />
					<Trans>Create credential</Trans>
				</Button>
			</div>
			{current && (
				<div className="grid gap-2">
					<CodeText text={current.publicKey} maxLines={4} label={t`Public key`} copy={false} />
					<div>
						<CopyButton text={current.publicKey} label={t`Copy public key`} showLabel variant="outline" />
					</div>
					<p className="text-sm text-muted-foreground">
						<Trans>
							Append this key to <code>~/.ssh/authorized_keys</code> of the target user on every hop (each jump host and
							the target), before continuing.
						</Trans>
					</p>
				</div>
			)}
		</div>
	);
}

function HopFields({ prefix, hop, onChange }: { prefix: string; hop: Hop; onChange: (patch: Partial<Hop>) => void }) {
	const { t } = useLingui();
	const id = (key: string) => `${prefix}-${key}`;
	return (
		<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)]">
			<FieldShell id={id("host")} label={t`Host`}>
				<Input id={id("host")} value={hop.host} onChange={(event) => onChange({ host: event.target.value })} />
			</FieldShell>
			<FieldShell id={id("port")} label={t`Port`}>
				<Input
					id={id("port")}
					inputMode="numeric"
					value={hop.port}
					onChange={(event) => onChange({ port: event.target.value })}
				/>
			</FieldShell>
			<FieldShell id={id("user")} label={t`User`}>
				<Input id={id("user")} value={hop.user} onChange={(event) => onChange({ user: event.target.value })} />
			</FieldShell>
		</div>
	);
}

/** Wizard step 2: target, node name and the ordered jump hosts (hops = jumps then target). */
function RouteStep({
	hops,
	onHops,
	name,
	onName,
}: {
	hops: Hop[];
	onHops: (hops: Hop[]) => void;
	name: string;
	onName: (name: string) => void;
}) {
	const { t } = useLingui();
	const prefix = useId();
	const last = hops.length - 1;
	return (
		<div className="grid gap-3" data-testid="ssh-step-route">
			{hops.slice(0, last).map((hop, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: jumps have no identity beyond their position
				<fieldset key={`jump-${index}`} className="grid gap-2 rounded-lg border p-3">
					<legend className="px-1 text-sm font-medium">{t`Jump host ${index + 1}`}</legend>
					<div className="flex flex-wrap justify-end gap-1">
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={index === 0}
							aria-label={t`Move jump host ${index + 1} up`}
							onClick={() => onHops(moveJump(hops, index, -1))}
						>
							<Trans>Up</Trans>
						</Button>
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={index === last - 1}
							aria-label={t`Move jump host ${index + 1} down`}
							onClick={() => onHops(moveJump(hops, index, 1))}
						>
							<Trans>Down</Trans>
						</Button>
						<Button
							type="button"
							variant="destructive"
							size="xs"
							aria-label={t`Remove jump host ${index + 1}`}
							onClick={() => onHops(removeJump(hops, index))}
						>
							<Trans>Remove</Trans>
						</Button>
					</div>
					<HopFields
						prefix={`${prefix}-jump-${index}`}
						hop={hop}
						onChange={(patch) => onHops(editHop(hops, index, patch))}
					/>
				</fieldset>
			))}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="justify-self-start"
				onClick={() => onHops(addJump(hops, emptyHop((hops[last] as Hop).user)))}
			>
				<PlusIcon />
				<Trans>Add jump host</Trans>
			</Button>
			<fieldset className="grid gap-2 rounded-lg border p-3">
				<legend className="px-1 text-sm font-medium">{t`Target`}</legend>
				<HopFields
					prefix={`${prefix}-target`}
					hop={hops[last] as Hop}
					onChange={(patch) => onHops(editHop(hops, last, patch))}
				/>
			</fieldset>
			<FieldShell id={`${prefix}-name`} label={t`Node name`} description={t`Optional; defaults to the target's host.`}>
				<Input id={`${prefix}-name`} value={name} maxLength={200} onChange={(event) => onName(event.target.value)} />
			</FieldShell>
		</div>
	);
}

/** Wizard step 3: probe each unpinned hop in turn and pin its fingerprint once the user confirms it. */
function HostKeyStep({
	hops,
	credentialId,
	onHops,
}: {
	hops: Hop[];
	credentialId: string;
	onHops: (hops: Hop[]) => void;
}) {
	const { t, i18n } = useLingui();
	const probe = useProbeSshHost();
	const [candidate, setCandidate] = useState<{ hop: number; fingerprint: string }>();
	const next = firstUnpinned(hops);

	return (
		<div className="grid gap-3" data-testid="ssh-step-host-keys">
			<ul className="grid gap-1 text-sm">
				{hops.map((hop, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: hops have no identity beyond their position
					<li key={`${hop.host}-${index}`} className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{hopName(i18n, hops, index)}</span>
						<code className="font-mono text-xs">
							{hop.host}:{hop.port}
						</code>
						{hop.hostKey ? (
							<code className="font-mono text-xs text-ok">{hop.hostKey}</code>
						) : (
							<span className="text-xs text-muted-foreground">{t`not checked`}</span>
						)}
					</li>
				))}
			</ul>

			{candidate && (
				<div className="grid gap-2 rounded-lg border p-3">
					<p className="text-sm">
						<Trans>Host key of the {hopName(i18n, hops, candidate.hop)}:</Trans>{" "}
						<code className="font-mono text-xs">{hops[candidate.hop]?.host}</code>
					</p>
					<p className="font-mono text-xs break-all">{candidate.fingerprint}</p>
					<p className="text-sm text-muted-foreground">
						<Trans>
							Compare it with the output of{" "}
							<code>for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done</code> on that host (the server
							picks one of its keys, usually ED25519). Only confirm if one of them matches.
						</Trans>
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							onClick={() => {
								onHops(pinHop(hops, candidate.hop, candidate.fingerprint));
								setCandidate(undefined);
							}}
						>
							<Trans>It matches, pin it</Trans>
						</Button>
						<Button type="button" variant="outline" onClick={() => setCandidate(undefined)}>
							<Trans>Discard</Trans>
						</Button>
					</div>
				</div>
			)}

			{!candidate && next >= 0 && (
				<Button
					type="button"
					className="justify-self-start"
					disabled={probe.isPending}
					onClick={() => {
						probe.mutate(
							{ ...hopBodies(hops), credentialId },
							{
								onSuccess: (result) => setCandidate(result),
							},
						);
					}}
				>
					{probe.isPending && <Spinner className="size-4" decorative />}
					<Trans>Check the next host key</Trans>
				</Button>
			)}
			{next < 0 && (
				<p role="status" className="text-sm text-ok">
					<Trans>All host keys are confirmed.</Trans>
				</p>
			)}
			<ErrorText error={probe.error} />
		</div>
	);
}

/** Wizard step 4: the summary, the route test and (in the footer) creation. */
function CreateStep({ hops, credentialId, name }: { hops: Hop[]; credentialId: string; name: string }) {
	const { t } = useLingui();
	const test = useTestSshRoute();
	const target = hops[hops.length - 1] as Hop;
	return (
		<div className="grid gap-3" data-testid="ssh-step-create">
			<KeyValueList
				items={[
					{ label: t`Node name`, value: name.trim() || target.host },
					{
						label: t`Route`,
						value: hops.map((hop) => `${hop.user}@${hop.host}:${hop.port}`).join(" → "),
						mono: true,
					},
				]}
			/>
			<p className="text-sm text-muted-foreground">
				<Trans>
					The node is active as soon as it is created; the pinned host keys are enforced on every connection. Test first
					to check that the key is installed on every hop and the account can run commands.
				</Trans>
			</p>
			<TestConnection testId="ssh-route-test" onTest={() => test.mutateAsync({ ...hopBodies(hops), credentialId })} />
		</div>
	);
}

/** The last step's submit; a separate component so the creation mutation is only mounted there. */
function WizardCreate({
	hops,
	credentialId,
	name,
	onCreated,
}: {
	hops: Hop[];
	credentialId: string;
	name: string;
	onCreated: (node: PublicNode) => void;
}) {
	const create = useCreateSshNode();
	return (
		<Button
			type="button"
			disabled={create.isPending}
			data-testid="ssh-create"
			onClick={() => {
				create.mutate(
					{
						...hopBodies(hops),
						credentialId,
						name: name.trim(),
					},
					{
						onSuccess: (node) => {
							onCreated(node);
						},
					},
				);
			}}
		>
			<Trans>Create node</Trans>
		</Button>
	);
}

/**
 * The four-step "Add SSH node" wizard: credential, route (jump hosts then
 * target), host-key pinning and creation. Each step validates before it lets
 * the user continue, and editing invalidates the step's error.
 */
export function SshNodeWizard({
	onCancel,
	onCreated,
}: {
	onCancel: () => void;
	onCreated: (node: PublicNode) => void;
}) {
	const { t, i18n } = useLingui();
	const [step, setStep] = useState(0);
	const [credentialId, setCredentialId] = useState("");
	const [hops, setHopList] = useState<Hop[]>([emptyHop()]);
	const [name, setName] = useState("");
	const [stepError, setStepError] = useState<string>();

	const setHops = (next: Hop[]) => {
		setStepError(undefined);
		setHopList(next);
	};

	const go = (to: number) => {
		setStepError(undefined);
		if (to > step) {
			if (step === 0 && credentialId === "") {
				setStepError(t`Choose or create a credential.`);
				return;
			}
			if (step === 1) {
				const bad = validateHops(hops);
				if (bad) {
					setStepError(hopErrorText(i18n, hops, bad));
					return;
				}
			}
			if (step === 2 && firstUnpinned(hops) >= 0) {
				setStepError(t`Confirm every host key first.`);
				return;
			}
		}
		setStep(to);
	};

	return (
		<div className="grid gap-4" data-testid="ssh-wizard">
			<ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t`Steps`}>
				{SSH_STEP_LABELS.map((label, index) => (
					<li
						key={label.id}
						aria-current={index === step ? "step" : undefined}
						className={index === step ? "font-medium text-foreground" : undefined}
					>
						{index + 1}. {i18n._(label)}
					</li>
				))}
			</ol>

			{step === 0 && (
				<CredentialStep value={credentialId} onChange={setCredentialId} onReadyChange={() => setStepError(undefined)} />
			)}
			{step === 1 && <RouteStep hops={hops} onHops={setHops} name={name} onName={setName} />}
			{step === 2 && <HostKeyStep hops={hops} credentialId={credentialId} onHops={setHops} />}
			{step === 3 && <CreateStep hops={hops} credentialId={credentialId} name={name} />}

			{/* The row keeps its height between steps; only a real message is an alert. */}
			<div className="min-h-5">
				{stepError !== undefined && (
					<p role="alert" className="text-sm text-danger">
						{stepError}
					</p>
				)}
			</div>

			<div className="flex flex-wrap items-center justify-end gap-2">
				{step > 0 && (
					<Button type="button" variant="outline" onClick={() => go(step - 1)}>
						<Trans>Back</Trans>
					</Button>
				)}
				<Button type="button" variant="outline" onClick={onCancel}>
					<Trans>Cancel</Trans>
				</Button>
				{step < SSH_STEP_LABELS.length - 1 ? (
					<Button type="button" onClick={() => go(step + 1)} data-testid="ssh-next">
						<Trans>Next</Trans>
					</Button>
				) : (
					<WizardCreate hops={hops} credentialId={credentialId} name={name} onCreated={onCreated} />
				)}
			</div>
		</div>
	);
}
