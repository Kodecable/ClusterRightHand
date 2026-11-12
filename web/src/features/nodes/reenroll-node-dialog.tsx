import type { PublicNode } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { CodeText } from "@/components/code-text";
import { CopyAndCloseButton, CopyButton } from "@/components/copy-button";
import { ErrorText } from "@/components/error-state";
import { DateTime } from "@/components/relative-time";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useReenrollNode } from "./api";
import { reenrollCommand } from "./commands";

/**
 * "Re-enroll": replaces a crha node's identity key while keeping its node record
 * (doc/guide/operations.md "Rotating and revoking node keys"). The one-time token is shown once; the
 * node becomes pending again and must be approved.
 */
export function ReenrollNodeDialog({ node, onClose }: { node: PublicNode; onClose: () => void }) {
	const { t } = useLingui();
	const [created, setCreated] = useState<{ token: string; expiresAt: string }>();
	const reenroll = useReenrollNode();
	const command = created ? reenrollCommand(window.location.origin, created.token) : "";

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent data-testid="reenroll-node-dialog" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>
						<Trans>Re-enroll node</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Replace the identity key of {node.name}. The node keeps its id, name, node groups and access grants. It
							must be approved again before it runs tasks.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3">
					{created ? (
						<>
							<p className="text-sm">
								<Trans>Stop crha, run this on the node, then start it again:</Trans>
							</p>
							<CodeText text={command} maxLines={4} label={t`Re-enrollment command`} copy={false} />
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-xs text-muted-foreground">
									<Trans>
										The token is shown once and expires <DateTime value={created.expiresAt} />.
									</Trans>
								</span>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-xs text-muted-foreground">
									<Trans>Token</Trans>
								</span>
								<code className="break-all rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
									{created.token}
								</code>
								<CopyButton text={created.token} label={t`Copy token`} variant="outline" />
							</div>
							<p className="text-sm text-muted-foreground">
								<Trans>
									After it connects, the node shows Pending approval. Compare its new key fingerprint with{" "}
									<code>crha status</code> before approving.
								</Trans>
							</p>
						</>
					) : (
						<p className="text-sm text-muted-foreground">
							<Trans>
								The old key stops working as soon as the node enrolls with the new token. If its key was lost or
								compromised, re-enroll rather than deleting the node.
							</Trans>
						</p>
					)}
					<ErrorText error={reenroll.error} />
				</div>
				<DialogFooter>
					{created ? (
						<CopyAndCloseButton text={command} onClose={onClose} />
					) : (
						<>
							<Button type="button" variant="outline" onClick={onClose}>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								type="button"
								disabled={reenroll.isPending}
								onClick={() => reenroll.mutate(node.id, { onSuccess: setCreated })}
							>
								{reenroll.isPending && <Spinner className="size-4" decorative />}
								<Trans>Create token</Trans>
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
