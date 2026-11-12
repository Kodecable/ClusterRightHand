import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { CodeText } from "@/components/code-text";
import { CopyButton } from "@/components/copy-button";
import { EntityPicker } from "@/components/entity-picker";
import { ErrorText } from "@/components/error-state";
import { CardSkeleton } from "@/components/skeletons";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCrhsKey } from "@/features/nodes/api";
import { useSigningCredentials } from "./api";
import { buildTrustConfig } from "./trust";

/**
 * Builds basic `[[trust]]` entries for a node's privileged.toml from crhs's signing key and, optionally,
 * user signing credentials. The node enforces the file; this dialog only exports it.
 */
export function TrustConfigDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useLingui();
	const id = useId();
	const crhsKey = useCrhsKey();
	const credentials = useSigningCredentials();
	const [keyIndex, setKeyIndex] = useState(0);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);

	const keys = crhsKey.data?.keys ?? [];
	const selectedKey = keys[keyIndex] ?? keys[0];
	const selected = (credentials.data ?? []).filter((credential) => selectedIds.includes(credential.id));
	const snippet = selectedKey === undefined ? undefined : buildTrustConfig(selectedKey.authorizedKey, selected);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-testid="trust-config-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Generate trust config</Trans>
					</DialogTitle>
				</DialogHeader>
				{crhsKey.isError ? (
					<ErrorText error={crhsKey.error} />
				) : !crhsKey.data ? (
					<CardSkeleton />
				) : keys.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						<Trans>crhs has no authorization signing key.</Trans>
					</p>
				) : (
					<div className="grid gap-4">
						<div className="grid gap-1.5">
							<Label htmlFor={`${id}-key`}>
								<Trans>crhs signing key</Trans>
							</Label>
							<Select value={String(keyIndex)} onValueChange={(value) => setKeyIndex(Number(value))}>
								<SelectTrigger id={`${id}-key`} className="w-full">
									<SelectValue>
										{(current: string | null) => {
											const index = Number(current ?? 0);
											const key = keys[index] ?? keys[0];
											return key === undefined ? null : index === 0 ? t`${key.fingerprint} (newest)` : key.fingerprint;
										}}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{keys.map((key, index) => (
										<SelectItem key={key.fingerprint} value={String(index)}>
											{index === 0 ? t`${key.fingerprint} (newest)` : key.fingerprint}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid gap-2">
							<p className="text-sm font-medium">
								<Trans>User signing credentials</Trans>
							</p>
							<EntityPicker
								kind="signingCredential"
								multiple
								label={t`User signing credentials`}
								value={selectedIds}
								onChange={(ids) => setSelectedIds(ids)}
								testId="trust-signing-credentials"
							/>
							<ErrorText error={credentials.error} />
						</div>
						<section className="grid gap-2">
							<div className="flex items-center justify-between gap-2">
								<h3 className="text-sm font-medium">
									<Trans>privileged.toml</Trans>
								</h3>
								<CopyButton text={snippet ?? ""} label={t`Copy trust config`} showLabel variant="outline" />
							</div>
							<CodeText
								text={snippet ?? ""}
								maxLines={0}
								preClassName="h-44 overflow-auto"
								label={t`Trust config`}
								copy={false}
							/>
							<p className="text-sm text-muted-foreground">
								{selected.length === 0 ? (
									<Trans>crhs may authorize privileged tasks on this node on its own.</Trans>
								) : (
									<Trans>
										Each selected signing credential may authorize a task, and crhs must countersign it; crhs cannot
										authorize alone.
									</Trans>
								)}
							</p>
						</section>
						<p className="text-xs text-muted-foreground">
							<Trans>
								For command limits, lifetimes, local approval and other advanced options, see the documentation and edit
								privileged.toml by hand.
							</Trans>
						</p>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
