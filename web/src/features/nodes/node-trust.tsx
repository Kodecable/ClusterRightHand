import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { DateTime } from "@/components/relative-time";
import { CardSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useNodeTrust } from "@/features/nodes/api";
import type { GuardRule, NodeTrust, TrustEntry, TrustEntryKey } from "@/lib/api/types";
import { formatDuration } from "@/lib/format";
import { useLocale } from "@/lib/i18n";

/** How a trust entry's key is identified on the node. */
export function trustKeyText(key: TrustEntryKey): string {
	switch (key.kind) {
		case "sshsig":
			return key.fingerprint ?? key.publicKey ?? "";
		case "webauthn":
			return key.rpId ?? "";
		case "local":
			return (key.uids ?? []).join(", ");
	}
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
						...(entry.key.publicKey !== undefined
							? [{ label: t`Public key`, value: entry.key.publicKey, mono: true }]
							: []),
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
	const queryClient = useQueryClient();
	const trust = useNodeTrust(nodeId);
	const data: NodeTrust | undefined = trust.data;

	return (
		<section className="grid gap-2" aria-labelledby="node-trust-heading" data-testid="node-trust">
			<div className="flex items-center justify-between gap-2">
				<h2 id="node-trust-heading" className="text-sm font-semibold">
					<Trans>Trust</Trans>
				</h2>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void queryClient.invalidateQueries({ queryKey: ["nodes", "trust", nodeId] })}
				>
					<Trans>Refresh</Trans>
				</Button>
			</div>
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
							{ label: t`Updated`, value: <DateTime value={data.updatedAt} seconds /> },
							...(data.summary !== null
								? [
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
						<p className="text-sm text-muted-foreground">
							<Trans>The node has not reported its trust configuration.</Trans>
						</p>
					) : data.summary.trust.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							<Trans>The node trusts nobody.</Trans>
						</p>
					) : (
						<>
							<div className="overflow-auto rounded-lg border">
								<Table aria-label={t`Trust entries`}>
									<TableHeader>
										<TableRow>
											<TableHead>{t`Name`}</TableHead>
											<TableHead>{t`Role`}</TableHead>
											<TableHead>{t`Format`}</TableHead>
											<TableHead>{t`Kinds`}</TableHead>
											<TableHead>{t`Flags`}</TableHead>
											<TableHead>{t`Max TTL`}</TableHead>
											<TableHead>{t`Key`}</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.summary.trust.map((entry) => (
											<TableRow key={entry.name}>
												<TableCell>{entry.name}</TableCell>
												<TableCell>{entry.role}</TableCell>
												<TableCell>{entry.key.kind}</TableCell>
												<TableCell>{entry.kinds.join(", ") || "–"}</TableCell>
												<TableCell>{trustFlags(entry)}</TableCell>
												<TableCell>{entry.maxTtlMs === null ? t`unlimited` : trustTtlText(entry.maxTtlMs)}</TableCell>
												<TableCell className="max-w-96 truncate font-mono text-xs">{trustKeyText(entry.key)}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
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
