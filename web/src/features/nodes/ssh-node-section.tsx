import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/dialogs";
import { FieldShell } from "@/components/form";
import { TestConnection } from "@/components/test-connection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSetNodeGroups, useTestSshNode } from "@/features/nodes/api";
import type { PublicNode, SshNodeDetails } from "@/lib/api/types";
import { parseList } from "@/lib/format";

function GroupsDialog({ node, onClose }: { node: PublicNode; onClose: () => void }) {
	const { t } = useLingui();
	const prefix = useId();
	const [groups, setGroups] = useState(node.groups.join(", "));
	const save = useSetNodeGroups();
	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Edit groups</Trans>}
			description={<Trans>Comma separated; they decide who may see and operate this node.</Trans>}
			submitLabel={<Trans>Save</Trans>}
			busy={save.isPending}
			error={save.error !== null ? save.error.message : undefined}
			onSubmit={() =>
				save.mutate(
					{ id: node.id, groups: parseList(groups) },
					{
						onSuccess: () => {
							toast.success(t`Groups saved.`);
							onClose();
						},
					},
				)
			}
		>
			<FieldShell id={`${prefix}-groups`} label={t`Groups`}>
				<Input id={`${prefix}-groups`} value={groups} onChange={(event) => setGroups(event.target.value)} />
			</FieldShell>
		</FormDialog>
	);
}

/** Route, pinned host keys, credential and groups of an SSH node, with a connection test. */
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
	const canManage = node.access === "owner" || node.access === "admin";
	const test = useTestSshNode();
	const [editingGroups, setEditingGroups] = useState(false);
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
			<div className="flex flex-wrap items-center gap-2">
				{canRun && <TestConnection testId="ssh-node-test" onTest={() => test.mutateAsync(node.id)} />}
				{canManage && (
					<Button type="button" variant="outline" size="sm" onClick={() => setEditingGroups(true)}>
						<Trans>Edit groups</Trans>
					</Button>
				)}
				{canManage && editingGroups && <GroupsDialog node={node} onClose={() => setEditingGroups(false)} />}
			</div>
		</section>
	);
}
