import { Trans, useLingui } from "@lingui/react/macro";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { ErrorText } from "@/components/error-state";
import { ShareEditor } from "@/components/share-editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSessionShares, useShareSession, useUnshareSession } from "@/features/sessions/api";

/**
 * The share dialog of a session (doc/access-control.md "归属与分享"): the
 * current shares, adding a user or user group with view/chat access, and removing
 * one. The dialog opens while the caller has `manageShares`; only the owner
 * (`createShares`) gets the add control, while an administrator can still revoke.
 */
export function ShareDialog({
	sessionId,
	canCreateShares,
	open,
	onOpenChange,
}: {
	sessionId: string;
	canCreateShares: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useLingui();
	const shares = useSessionShares(open ? sessionId : undefined);
	const share = useShareSession(sessionId);
	const unshare = useUnshareSession(sessionId);

	const remove = (shareId: string) => {
		unshare.mutate(shareId, { onSuccess: () => toast.success(t`Share removed.`) });
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md" data-testid="share-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Shares</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>People you share this session with; view access is read-only, chat access can send messages.</Trans>
					</DialogDescription>
				</DialogHeader>

				{shares.isPending ? (
					<p className="text-sm text-muted-foreground">
						<Trans>Loading shares…</Trans>
					</p>
				) : shares.data && shares.data.length > 0 ? (
					<ul className="grid gap-1" data-testid="share-list">
						{shares.data.map((item) => (
							<li key={item.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
								<span className="min-w-0 flex-1 truncate">
									{item.granteeType === "user" ? <Trans>User</Trans> : <Trans>User group</Trans>}{" "}
									<span className="font-mono text-xs">{item.granteeName ?? item.granteeId}</span>
								</span>
								<span className="text-xs text-muted-foreground">
									{item.access === "chat" ? <Trans>Chat</Trans> : <Trans>View</Trans>}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label={t`Remove share`}
									disabled={unshare.isPending}
									onClick={() => remove(item.id)}
								>
									<Trash2Icon />
								</Button>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">
						<Trans>Not shared.</Trans>
					</p>
				)}

				{canCreateShares && (
					<ShareEditor
						layout="stacked"
						accessOptions={[
							{ value: "view", label: <Trans>View</Trans> },
							{ value: "chat", label: <Trans>Chat</Trans> },
						]}
						defaultAccess="view"
						userGroupLabel={<Trans>User group</Trans>}
						busy={share.isPending}
						onAdd={async ({ granteeType, granteeId, access }) => {
							try {
								await share.mutateAsync({ granteeType, granteeId, access });
								toast.success(t`Shared.`);
								return true;
							} catch {
								return false;
							}
						}}
					/>
				)}

				<ErrorText error={shares.error ?? share.error ?? unshare.error} />
			</DialogContent>
		</Dialog>
	);
}
