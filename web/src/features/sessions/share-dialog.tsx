import { Trans, useLingui } from "@lingui/react/macro";
import { XIcon } from "lucide-react";
import { ErrorText } from "@/components/error-state";
import { ShareEditor } from "@/components/share-editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSessionShares, useShareSession, useUnshareSession } from "@/features/sessions/api";
import { MONO_CELL } from "@/lib/utils";

/**
 * The share dialog of a session (doc/design/access-control.md "Ownership, access grants and sharing"): the
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
		unshare.mutate(shareId);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-testid="share-dialog">
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
							<li key={item.id} className="flex min-h-8 items-center gap-2 rounded-md border px-2 text-sm">
								<span className="min-w-0 flex-1 truncate">
									{item.granteeType === "user" ? <Trans>User</Trans> : <Trans>User group</Trans>}{" "}
									<span className={MONO_CELL}>{item.granteeName ?? item.granteeId}</span>
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
									<XIcon />
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
						busy={share.isPending}
						onAdd={async ({ granteeType, granteeId, access }) => {
							try {
								await share.mutateAsync({ granteeType, granteeId, access });
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
