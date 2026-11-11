import type { PublicNode, SshNodeDetails } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { TestConnection } from "@/components/test-connection";
import { useTestSshNode } from "@/features/nodes/api";
import { cn, MONO_CELL } from "@/lib/utils";

/** Route with each hop's credential and pinned host fingerprint, plus a connection test. */
export function SshNodeSection({
	node,
	details,
	canRun,
}: {
	node: PublicNode;
	details: SshNodeDetails | null | undefined;
	canRun: boolean;
}) {
	const { t } = useLingui();
	const test = useTestSshNode();
	const columns: DataTableColumn<SshNodeDetails["hops"][number]>[] = [
		{
			id: "hop",
			header: t`Hop`,
			size: 110,
			cell: ({ row }) => (row.index === (details?.hops.length ?? 0) - 1 ? t`Target` : t`Jump ${row.index + 1}`),
		},
		{
			id: "address",
			header: t`Address`,
			minSize: 160,
			cell: ({ row }) => (
				<span className={MONO_CELL}>
					{row.original.user}@{row.original.host}:{row.original.port}
				</span>
			),
			meta: { title: (hop: SshNodeDetails["hops"][number]) => `${hop.user}@${hop.host}:${hop.port}` },
		},
		{
			id: "credential",
			header: t`Credential`,
			minSize: 140,
			cell: ({ row }) => (
				<span className="block truncate">{row.original.credential.name ?? row.original.credential.id}</span>
			),
			meta: { title: (hop: SshNodeDetails["hops"][number]) => hop.credential.name ?? hop.credential.id },
		},
		{
			id: "hostFingerprint",
			header: t`Host fingerprint`,
			minSize: 180,
			cell: ({ row }) => <span className={cn("block truncate", MONO_CELL)}>{row.original.hostFingerprint}</span>,
			meta: { title: (hop: SshNodeDetails["hops"][number]) => hop.hostFingerprint },
		},
	];
	return (
		<section className="grid gap-2" aria-labelledby="ssh-node-heading" data-testid="ssh-node-section">
			<h2 id="ssh-node-heading" className="text-sm font-medium">
				<Trans>SSH</Trans>
			</h2>
			{details && <DataTable label={t`SSH route`} columns={columns} data={details.hops} density="compact" />}
			{canRun && (
				<div className="flex flex-wrap items-center gap-2">
					<TestConnection testId="ssh-node-test" onTest={() => test.mutateAsync(node.id)} />
				</div>
			)}
		</section>
	);
}
