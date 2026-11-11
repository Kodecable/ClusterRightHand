import type { PublicNode, SshNodeDetails } from "@crh/api";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { ErrorText } from "@/components/error-state";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogScrollArea,
	DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateSshNodeRoute } from "./api";
import { SshRouteEditor } from "./ssh-route-editor";
import { firstUnpinned, type Hop, hopBodies, validateHops } from "./sshHops";

function initialHops(details: SshNodeDetails): Hop[] {
	return details.hops.map((hop) => ({
		host: hop.host,
		port: String(hop.port),
		user: hop.user,
		hostFingerprint: hop.hostFingerprint,
		credentialId: hop.credentialId,
	}));
}

/**
 * "Edit route": replaces an SSH node's hops and their credentials with the same route table as adding
 * one. Saving closes the pooled connection, so tasks running on it become unknown
 * (doc/design/execution.md "Adding an SSH node").
 */
export function EditSshRouteDialog({
	node,
	details,
	onClose,
}: {
	node: PublicNode;
	details: SshNodeDetails;
	onClose: () => void;
}) {
	const update = useUpdateSshNodeRoute();
	const [hops, setHops] = useState<Hop[]>(() => initialHops(details));
	// Every row needs a host, user, credential and confirmed fingerprint before the route can be saved.
	const ready = validateHops(hops) === undefined && firstUnpinned(hops) < 0;

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-5xl" data-testid="edit-ssh-route-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Edit SSH route</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>Saving closes the connection; tasks running on this node become unknown.</Trans>
					</DialogDescription>
				</DialogHeader>
				<DialogScrollArea className="max-h-[70vh]">
					<SshRouteEditor hops={hops} onHops={setHops} />
				</DialogScrollArea>
				<ErrorText error={update.error} />
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={!ready || update.isPending}
						data-testid="save-ssh-route"
						onClick={() => {
							update.mutate({ id: node.id, body: hopBodies(hops) }, { onSuccess: onClose });
						}}
					>
						{update.isPending && <Spinner className="size-4" decorative />}
						<Trans>Save</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
