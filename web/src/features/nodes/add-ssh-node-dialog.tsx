import { Trans } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogScrollArea,
	DialogTitle,
} from "@/components/ui/dialog";
import { SshNodeWizard } from "./ssh-wizard";

/** The dialog around the four-step SSH wizard; a created node is opened at once. */
export function AddSshNodeDialog({ onClose }: { onClose: () => void }) {
	const navigate = useNavigate();
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>New SSH node</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Choose a credential, describe the route (jump hosts, then the target), pin every host key, then create the
							node.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<DialogScrollArea className="max-h-[70vh]">
					<SshNodeWizard
						onCancel={onClose}
						onCreated={(node) => {
							onClose();
							void navigate({ to: "/nodes/$nodeId", params: { nodeId: node.id } });
						}}
					/>
				</DialogScrollArea>
			</DialogContent>
		</Dialog>
	);
}
