import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EntityPicker } from "@/components/entity-picker";
import { ErrorText } from "@/components/error-state";
import { FieldShell } from "@/components/form";
import { RowRemoveButton } from "@/components/row-remove-button";
import { SectionHeader } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProbeSshHost } from "@/features/nodes/api";
import { useSshCredentials } from "@/features/ssh-credentials/api";
import { cn, linkClass, MONO_CELL } from "@/lib/utils";
import { addHop, editHop, type Hop, type HopError, hopBodies, pinHop, removeHop } from "./sshHops";

const HOP_ERRORS: Record<HopError["code"], MessageDescriptor> = {
	"host-required": msg`A host is required.`,
	"user-required": msg`A user is required.`,
	"port-invalid": msg`The port must be between 1 and 65535.`,
	"credential-required": msg`An SSH credential is required.`,
};

/** "Target" or "Jump N", for messages about a hop. */
export function hopName(i18n: I18n, hops: Hop[], index: number): string {
	return index === hops.length - 1 ? i18n._(msg`Target`) : i18n._(msg`Jump {index}`.id, { index: index + 1 });
}

/** The translated description of a hop validation failure. */
export function hopErrorText(i18n: I18n, hops: Hop[], error: HopError): string {
	return `${hopName(i18n, hops, error.hop)}: ${i18n._(HOP_ERRORS[error.code])}`;
}

function addressReady(hop: Hop): boolean {
	const port = Number(hop.port);
	return hop.host.trim() !== "" && hop.user.trim() !== "" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * The route table shared by "New SSH node" and "Edit route": jumps first, the target last, with a host,
 * user, credential and pinned host fingerprint per row. Probing reaches the first unpinned hop, so a row
 * can be probed once every row before it is pinned and has a credential.
 */
export function SshRouteEditor({
	hops,
	onHops,
	name,
	onName,
}: {
	hops: Hop[];
	onHops: (hops: Hop[]) => void;
	name?: string;
	onName?: (name: string) => void;
}) {
	const { t, i18n } = useLingui();
	const prefix = useId();
	const credentials = useSshCredentials();
	const probe = useProbeSshHost();
	const [candidate, setCandidate] = useState<{ hop: number; fingerprint: string }>();
	// The cells read the current rows through refs, so the column definitions stay stable: recreating them
	// on every keystroke would remount the inputs and lose the caret.
	const hopsRef = useRef(hops);
	hopsRef.current = hops;
	const onHopsRef = useRef(onHops);
	onHopsRef.current = onHops;
	const probeRef = useRef(probe);
	probeRef.current = probe;

	const canProbe = useCallback((index: number) => {
		const current = hopsRef.current;
		return (
			addressReady(current[index] as Hop) &&
			current.slice(0, index).every((hop) => hop.hostFingerprint !== "" && hop.credentialId !== "")
		);
	}, []);

	const probeHop = useCallback((index: number) => {
		const current = hopsRef.current;
		const cleared = current.map((hop, i) => (i === index ? { ...hop, hostFingerprint: "" } : hop));
		probeRef.current.mutate(hopBodies(cleared), { onSuccess: (result) => setCandidate(result) });
	}, []);

	const columns = useMemo<DataTableColumn<Hop>[]>(
		() => [
			{
				id: "hop",
				header: t`Hop`,
				size: 96,
				cell: ({ row }) =>
					row.index === hopsRef.current.length - 1 ? (
						<Badge variant="secondary">
							<Trans>Target</Trans>
						</Badge>
					) : (
						<span className="text-xs text-muted-foreground">{hopName(i18n, hopsRef.current, row.index)}</span>
					),
			},
			{
				id: "host",
				header: t`Host`,
				minSize: 170,
				cell: ({ row }) => (
					<Input
						aria-label={`${t`Host`} — ${hopName(i18n, hopsRef.current, row.index)}`}
						value={row.original.host}
						onChange={(event) => onHopsRef.current(editHop(hopsRef.current, row.index, { host: event.target.value }))}
					/>
				),
			},
			{
				id: "port",
				header: t`Port`,
				size: 76,
				cell: ({ row }) => (
					<Input
						aria-label={`${t`Port`} — ${hopName(i18n, hopsRef.current, row.index)}`}
						inputMode="numeric"
						value={row.original.port}
						onChange={(event) => onHopsRef.current(editHop(hopsRef.current, row.index, { port: event.target.value }))}
					/>
				),
			},
			{
				id: "user",
				header: t`User`,
				minSize: 120,
				cell: ({ row }) => (
					<Input
						aria-label={`${t`User`} — ${hopName(i18n, hopsRef.current, row.index)}`}
						value={row.original.user}
						onChange={(event) => onHopsRef.current(editHop(hopsRef.current, row.index, { user: event.target.value }))}
					/>
				),
			},
			{
				id: "credential",
				header: t`Credential`,
				minSize: 170,
				cell: ({ row }) => (
					<EntityPicker
						kind="sshCredential"
						label={`${t`Credential`} — ${hopName(i18n, hopsRef.current, row.index)}`}
						value={row.original.credentialId === "" ? null : row.original.credentialId}
						onChange={(id) => onHopsRef.current(editHop(hopsRef.current, row.index, { credentialId: id ?? "" }))}
					/>
				),
			},
			{
				id: "hostFingerprint",
				header: t`Host fingerprint`,
				minSize: 230,
				cell: ({ row }) => {
					const hop = row.original;
					return (
						<div className="flex min-w-0 items-center gap-1.5">
							{hop.hostFingerprint !== "" ? (
								<code className={cn("min-w-0 truncate", MONO_CELL)} title={hop.hostFingerprint}>
									{hop.hostFingerprint}
								</code>
							) : (
								<span className="text-xs text-muted-foreground">
									<Trans>Not confirmed</Trans>
								</span>
							)}
							<Button
								type="button"
								variant="outline"
								size="xs"
								disabled={probe.isPending || !canProbe(row.index)}
								aria-label={`${hop.hostFingerprint !== "" ? t`Re-probe` : t`Probe`} — ${hopName(i18n, hopsRef.current, row.index)}`}
								onClick={() => probeHop(row.index)}
							>
								{hop.hostFingerprint !== "" ? <Trans>Re-probe</Trans> : <Trans>Probe</Trans>}
							</Button>
						</div>
					);
				},
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 96,
				cell: ({ row }) => (
					<RowRemoveButton
						label={t`Remove ${hopName(i18n, hopsRef.current, row.index)}`}
						disabled={hopsRef.current.length === 1}
						onClick={() => onHopsRef.current(removeHop(hopsRef.current, row.index))}
					/>
				),
			},
		],
		[t, i18n, probe.isPending, canProbe, probeHop],
	);

	return (
		<div className="grid gap-3" data-testid="ssh-route-editor">
			{name !== undefined && onName && (
				<FieldShell
					id={`${prefix}-name`}
					label={t`Node name`}
					description={t`Optional; defaults to the target's host.`}
				>
					<Input id={`${prefix}-name`} value={name} maxLength={200} onChange={(event) => onName(event.target.value)} />
				</FieldShell>
			)}
			<section className="grid gap-2" aria-labelledby={`${prefix}-route`}>
				<SectionHeader
					id={`${prefix}-route`}
					title={<Trans>Route</Trans>}
					actions={
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={hops.length >= 6}
							onClick={() => onHops(addHop(hops))}
						>
							<PlusIcon />
							<Trans>Add hop</Trans>
						</Button>
					}
				/>
				<DataTable label={t`SSH route`} columns={columns} data={hops} density="compact" />
				{credentials.data !== undefined && credentials.data.length === 0 && (
					<p className="text-sm text-muted-foreground">
						<Trans>No SSH credentials yet.</Trans>{" "}
						<Link to="/ssh-credentials" className={linkClass}>
							<Trans>Create one on the SSH credentials page.</Trans>
						</Link>
					</p>
				)}
				<ErrorText error={probe.error} />
			</section>

			{candidate && (
				<ConfirmDialog
					open
					onOpenChange={(open) => {
						if (!open) setCandidate(undefined);
					}}
					destructive={false}
					title={t`Pin the host fingerprint of the ${hopName(i18n, hops, candidate.hop)}?`}
					confirmLabel={<Trans>Matches, pin it</Trans>}
					onConfirm={() => {
						onHops(pinHop(hops, candidate.hop, candidate.fingerprint));
						setCandidate(undefined);
					}}
					description={
						<span className="grid gap-2">
							<span>
								<Trans>Host:</Trans>{" "}
								<code className="font-mono">
									{hops[candidate.hop]?.host}:{hops[candidate.hop]?.port}
								</code>
							</span>
							<code className="block font-mono text-xs break-all text-foreground">{candidate.fingerprint}</code>
							<span>
								<Trans>
									Compare it with the output of{" "}
									<code>for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done</code> on that host (the server
									picks one of its keys, usually ED25519). Only confirm if one of them matches.
								</Trans>
							</span>
						</span>
					}
				/>
			)}
		</div>
	);
}
