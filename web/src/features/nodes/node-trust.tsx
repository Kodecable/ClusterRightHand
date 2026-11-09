import type { GuardRule, NodeTrust, TrustEntry, TrustEntryKey } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyHint } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { DateTime } from "@/components/relative-time";
import { CardSkeleton } from "@/components/skeletons";
import { useNodeGroups } from "@/features/node-groups/api";
import { useNodeTrust } from "@/features/nodes/api";
import { formatDuration } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { MONO_CELL } from "@/lib/utils";

/** How a trust entry's key is identified on the node. */
export function trustKeyText(key: TrustEntryKey): string {
	switch (key.kind) {
		case "sshsig":
			return key.fingerprint;
		case "webauthn":
			return key.rpId;
		case "local":
			return key.uids.join(", ");
	}
}

/** The node's aliases, each UUID with its node group's current name when the UUID names one. */
function TrustAliases({ aliases }: { aliases: readonly string[] }) {
	const groups = useNodeGroups();
	const names = useMemo(() => new Map((groups.data ?? []).map((group) => [group.id, group.name])), [groups.data]);
	if (aliases.length === 0) return <>–</>;
	return (
		<span data-slot="trust-aliases" className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
			{aliases.map((alias, index) => (
				<span key={alias} className="inline-flex items-center gap-1">
					{index > 0 && <span className="text-muted-foreground">,</span>}
					<code className={MONO_CELL}>{alias}</code>
					{names.has(alias) && <span className="text-xs text-muted-foreground">({names.get(alias)})</span>}
				</span>
			))}
		</span>
	);
}

/** A trust entry's maximum signature lifetime, e.g. "5m"; null is rendered as "unlimited". */
export function trustTtlText(ms: number): string {
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return `${ms}ms`;
}

export function guardRuleText(rule: GuardRule, anyTarget = "any target"): string {
	const target = rule.match === "any" ? anyTarget : `${rule.match} ${rule.pattern}`;
	return `${rule.method} ${target}`;
}

function trustFlags(entry: TrustEntry): string {
	return (
		[entry.requireExact && "require_exact", entry.requireTask && "require_task", entry.requireUv && "require_uv"]
			.filter(Boolean)
			.join(", ") || "–"
	);
}

function TrustRules({ entry }: { entry: TrustEntry }) {
	const { t } = useLingui();
	return (
		<details className="rounded-md border p-2">
			<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
				{t`Rules of ${entry.name}`}
			</summary>
			<div className="mt-2">
				<KeyValueList
					items={[
						{
							label: t`Allow`,
							value:
								entry.allow.map((rule) => guardRuleText(rule, t`any target`)).join("; ") || t`any method and target`,
							mono: entry.allow.length > 0,
						},
						{
							label: t`Deny`,
							value: entry.deny.map((rule) => guardRuleText(rule, t`any target`)).join("; ") || "–",
							mono: entry.deny.length > 0,
						},
						{ label: t`Environment`, value: entry.envAllow.join(", ") || "–", mono: true },
						...(entry.key.kind === "sshsig" ? [{ label: t`Public key`, value: entry.key.publicKey, mono: true }] : []),
					]}
				/>
			</div>
		</details>
	);
}

/**
 * Who a node trusts (doc/privilege.md#信任缓存): the last TrustReport it pushed,
 * its digest, the run identities, and every trust entry with its flags, rules
 * and allowed environment.
 */
export function NodeTrustPanel({ nodeId }: { nodeId: string }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const trust = useNodeTrust(nodeId);
	const data: NodeTrust | undefined = trust.data;
	const columns: DataTableColumn<TrustEntry>[] = [
		{
			id: "name",
			header: t`Name`,
			minSize: 140,
			cell: ({ row }) => row.original.name,
			meta: { title: (entry: TrustEntry) => entry.name },
		},
		{ id: "role", header: t`Role`, size: 100, cell: ({ row }) => row.original.role },
		{ id: "format", header: t`Format`, size: 100, cell: ({ row }) => row.original.key.kind },
		{
			id: "kinds",
			header: t`Kinds`,
			size: 120,
			cell: ({ row }) =>
				row.original.kinds.length === 0 ? (
					<span className="text-muted-foreground">–</span>
				) : (
					row.original.kinds.join(", ")
				),
		},
		{
			id: "flags",
			header: t`Flags`,
			minSize: 120,
			cell: ({ row }) =>
				trustFlags(row.original) === "–" ? <span className="text-muted-foreground">–</span> : trustFlags(row.original),
			meta: { title: (entry: TrustEntry) => trustFlags(entry) },
		},
		{
			id: "ttl",
			header: t`Max TTL`,
			size: 100,
			cell: ({ row }) => (row.original.maxTtlMs === null ? t`unlimited` : trustTtlText(row.original.maxTtlMs)),
		},
		{
			id: "key",
			header: t`Key`,
			cell: ({ row }) => <span className={MONO_CELL}>{trustKeyText(row.original.key)}</span>,
			meta: { title: (entry: TrustEntry) => trustKeyText(entry.key) },
		},
	];

	return (
		<section className="grid gap-2" aria-labelledby="node-trust-heading" data-testid="node-trust">
			<h2 id="node-trust-heading" className="text-sm font-medium">
				<Trans>Trust</Trans>
			</h2>
			{trust.isError ? (
				<ErrorState error={trust.error} retry={() => void trust.refetch()} compact />
			) : !data ? (
				<CardSkeleton />
			) : (
				<>
					<KeyValueList
						items={[
							{
								label: t`Report`,
								value: (
									<span>
										{data.status ?? t`not reported`}
										{data.stale && (
											<span className="text-muted-foreground">
												{" "}
												(<Trans>last report, stale until the node reconnects</Trans>)
											</span>
										)}
									</span>
								),
							},
							...(data.message !== null ? [{ label: t`Message`, value: data.message }] : []),
							{ label: t`Digest`, value: data.digest ?? "–", mono: true },
							{ label: t`Updated`, value: <DateTime value={data.updatedAt} /> },
							...(data.summary !== null
								? [
										{
											label: t`Aliases`,
											value: <TrustAliases aliases={data.summary.aliases} />,
										},
										{
											label: t`Clock skew`,
											value: formatDuration(Math.abs(data.summary.clockSkewMs), locale),
										},
										{
											label: t`Unprivileged identity`,
											value: `${data.summary.identities.unprivileged.user} (uid ${data.summary.identities.unprivileged.uid}, gid ${data.summary.identities.unprivileged.gid})`,
											mono: true,
										},
										{
											label: t`Privileged identity`,
											value: `${data.summary.identities.privileged.user} (uid ${data.summary.identities.privileged.uid}, gid ${data.summary.identities.privileged.gid})`,
											mono: true,
										},
									]
								: []),
						]}
					/>
					{data.summary === null ? (
						<EmptyHint>
							<Trans>The node has not reported its trust configuration</Trans>
						</EmptyHint>
					) : data.summary.trust.length === 0 ? (
						<EmptyHint>
							<Trans>The node trusts nobody</Trans>
						</EmptyHint>
					) : (
						<>
							<DataTable
								label={t`Trust entries`}
								columns={columns}
								data={data.summary.trust}
								getRowId={(entry) => entry.name}
								density="compact"
							/>
							<div className="grid gap-2">
								{data.summary.trust.map((entry) => (
									<TrustRules key={entry.name} entry={entry} />
								))}
							</div>
						</>
					)}
				</>
			)}
		</section>
	);
}
