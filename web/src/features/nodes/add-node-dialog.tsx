import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { CodeText } from "@/components/code-text";
import { CopyButton } from "@/components/copy-button";
import { ErrorText } from "@/components/error-state";
import { FieldShell } from "@/components/form";
import { DateTime } from "@/components/relative-time";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useEnrollmentToken } from "@/features/nodes/api";
import { enrollCommand } from "@/features/nodes/commands";

/**
 * "Add node": creates a one-time enrollment token and shows the command to run
 * on the node. The token is shown once; the node appears as pending until an
 * administrator approves its key fingerprint.
 */
export function AddNodeDialog({ onClose }: { onClose: () => void }) {
	const { t } = useLingui();
	const prefix = useId();
	const [hint, setHint] = useState("");
	const [created, setCreated] = useState<{ token: string; expiresAt: string }>();
	const create = useEnrollmentToken();
	const command = created ? enrollCommand(window.location.origin, created.token) : "";

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent data-testid="add-node-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Add node</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Create an enrollment token, then run the printed command on the node as the user crha should run tasks as.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3">
					{created ? (
						<>
							<p className="text-sm">
								<Trans>Run this on the node:</Trans>
							</p>
							<CodeText text={command} maxLines={4} label={t`Enrollment command`} copy={false} />
							<p className="text-xs text-muted-foreground">
								<Trans>
									The config file and state directory paths are a suggested layout; adjust them to your installation.
								</Trans>
							</p>
							<div className="flex flex-wrap items-center gap-2">
								<CopyButton text={command} label={t`Copy command`} showLabel variant="outline" />
								<span className="text-xs text-muted-foreground">
									<Trans>
										The token is shown once and expires <DateTime value={created.expiresAt} />.
									</Trans>
								</span>
							</div>
							<p className="text-sm text-muted-foreground">
								<Trans>
									After the node connects it appears as pending; compare its key fingerprint with{" "}
									<code>crha status</code> on the node before approving.
								</Trans>
							</p>
						</>
					) : (
						<FieldShell
							id={`${prefix}-hint`}
							label={t`Node name`}
							description={t`Optional; it defaults to the node's hostname.`}
						>
							<Input
								id={`${prefix}-hint`}
								value={hint}
								maxLength={200}
								onChange={(event) => setHint(event.target.value)}
							/>
						</FieldShell>
					)}
					<ErrorText error={create.error} />
					<div className="flex flex-wrap justify-end gap-2">
						{created ? (
							<Button type="button" onClick={onClose}>
								<Trans>Close</Trans>
							</Button>
						) : (
							<>
								<Button type="button" variant="outline" onClick={onClose}>
									<Trans>Cancel</Trans>
								</Button>
								<Button
									type="button"
									disabled={create.isPending}
									onClick={() => create.mutate(hint.trim() || undefined, { onSuccess: setCreated })}
								>
									{create.isPending && <Spinner className="size-4" decorative />}
									<Trans>Create token</Trans>
								</Button>
							</>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
