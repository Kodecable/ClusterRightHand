import { Trans, useLingui } from "@lingui/react/macro";
import { TestConnection } from "@/components/test-connection";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTestSshNode } from "@/features/nodes/api";
import type { PublicNode, SshNodeDetails } from "@/lib/api/types";

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
	return (
		<section className="grid gap-2" aria-labelledby="ssh-node-heading" data-testid="ssh-node-section">
			<h2 id="ssh-node-heading" className="text-sm font-semibold">
				<Trans>SSH</Trans>
			</h2>
			{details && (
				<>
					<div className="overflow-auto rounded-lg border">
						<Table aria-label={t`SSH route`}>
							<TableHeader>
								<TableRow>
									<TableHead>{t`Hop`}</TableHead>
									<TableHead>{t`Address`}</TableHead>
									<TableHead>{t`Pinned host key`}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{details.hops.map((hop, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: hops have no identity beyond their position
									<TableRow key={`${hop.host}-${index}`}>
										<TableCell>{index === details.hops.length - 1 ? t`Target` : t`Jump host ${index + 1}`}</TableCell>
										<TableCell className="font-mono text-xs">
											{hop.user}@{hop.host}:{hop.port}
										</TableCell>
										<TableCell className="font-mono text-xs">{hop.hostKey}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
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
