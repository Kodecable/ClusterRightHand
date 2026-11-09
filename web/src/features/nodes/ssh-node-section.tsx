import type { PublicNode, SshNodeDetails } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { TestConnection } from "@/components/test-connection";
import { useTestSshNode } from "@/features/nodes/api";
import { MONO_CELL } from "@/lib/utils";

/** Route, pinned host keys and credential of an SSH node, with a connection test. */
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
			cell: ({ row }) => (row.index === (details?.hops.length ?? 0) - 1 ? t`Target` : t`Jump host ${row.index + 1}`),
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
			id: "hostKey",
			header: t`Pinned host key`,
			minSize: 180,
			cell: ({ row }) => <span className={MONO_CELL}>{row.original.hostKey}</span>,
			meta: { title: (hop: SshNodeDetails["hops"][number]) => hop.hostKey },
		},
	];
	return (
		<section className="grid gap-2" aria-labelledby="ssh-node-heading" data-testid="ssh-node-section">
			<h2 id="ssh-node-heading" className="text-sm font-medium">
				<Trans>SSH</Trans>
			</h2>
			{details && (
				<>
					<DataTable
						label={t`SSH route`}
						columns={columns}
						data={details.hops}
						getRowId={(hop) => `${hop.user}@${hop.host}:${hop.port}`}
						density="compact"
					/>
					<p className="text-sm text-muted-foreground">
						<Trans>Credential: {details.credential.name ?? details.credential.id}</Trans>
					</p>
				</>
			)}
			{canRun && (
				<div className="flex flex-wrap items-center gap-2">
					<TestConnection testId="ssh-node-test" onTest={() => test.mutateAsync(node.id)} />
				</div>
			)}
		</section>
	);
}
