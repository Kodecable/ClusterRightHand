import { Trans, useLingui } from "@lingui/react/macro";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSessionShares, useShareSession, useUnshareSession } from "@/features/sessions/api";
import { useDirectory } from "@/features/users/api";
import type { GranteeType } from "@/lib/api/types";

/**
 * The share dialog of a session (doc/access-control.md "归属与分享"): the
 * current shares, adding a user or group with view/chat access, and removing
 * one. A share is only offered while the caller has `manageShares`.
 */
export function ShareDialog({
	sessionId,
	open,
	onOpenChange,
}: {
	sessionId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useLingui();
	const shares = useSessionShares(open ? sessionId : undefined);
	const directory = useDirectory();
	const share = useShareSession(sessionId);
	const unshare = useUnshareSession(sessionId);
	const [granteeType, setGranteeType] = useState<GranteeType>("user");
	const [granteeId, setGranteeId] = useState("");
	const [access, setAccess] = useState<"view" | "chat">("view");

	const users = directory.data?.users ?? [];
	const groups = directory.data?.userGroups ?? [];
	const options =
		granteeType === "user"
			? users.map((user) => ({ id: user.id, label: user.displayName || user.username }))
			: groups.map((group) => ({ id: group.id, label: group.name }));

	const add = () => {
		if (granteeId === "") return;
		share.mutate(
			{ granteeType, granteeId, access },
			{
				onSuccess: () => {
					toast.success(t`Shared.`);
					setGranteeId("");
				},
				onError: (error) => toast.error(error.message),
			},
		);
	};

	const remove = (shareId: string) => {
		unshare.mutate(shareId, {
			onSuccess: () => toast.success(t`Share removed.`),
			onError: (error) => toast.error(error.message),
		});
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
									{item.granteeType === "user" ? <Trans>User</Trans> : <Trans>Group</Trans>}{" "}
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

				<div className="grid gap-2 rounded-md border p-3">
					<div className="grid grid-cols-2 gap-2">
						<div className="grid gap-1.5">
							<Label htmlFor="share-type">
								<Trans>Type</Trans>
							</Label>
							<Select
								value={granteeType}
								onValueChange={(next) => {
									if (typeof next !== "string") return;
									setGranteeType(next as GranteeType);
									setGranteeId("");
								}}
							>
								<SelectTrigger id="share-type" className="w-full">
									<SelectValue>
										{(current: string | null) =>
											current === "user_group" ? <Trans>User group</Trans> : <Trans>User</Trans>
										}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="user">
										<Trans>User</Trans>
									</SelectItem>
									<SelectItem value="user_group">
										<Trans>User group</Trans>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="share-access">
								<Trans>Access</Trans>
							</Label>
							<Select
								value={access}
								onValueChange={(next) => {
									if (next === "view" || next === "chat") setAccess(next);
								}}
							>
								<SelectTrigger id="share-access" className="w-full">
									<SelectValue>
										{(current: string | null) => (current === "chat" ? <Trans>Chat</Trans> : <Trans>View</Trans>)}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="view">
										<Trans>View</Trans>
									</SelectItem>
									<SelectItem value="chat">
										<Trans>Chat</Trans>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="share-grantee">
							<Trans>Grantee</Trans>
						</Label>
						<Select
							value={granteeId === "" ? null : granteeId}
							onValueChange={(next) => setGranteeId(String(next ?? ""))}
						>
							<SelectTrigger id="share-grantee" className="w-full">
								<SelectValue placeholder={t`Select…`}>
									{(current: string | null) => options.find((option) => option.id === current)?.label ?? t`Select…`}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{options.map((option) => (
									<SelectItem key={option.id} value={option.id}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<Button type="button" size="sm" disabled={granteeId === "" || share.isPending} onClick={add}>
						<Trans>Add share</Trans>
					</Button>
				</div>

				<ErrorText error={shares.error ?? share.error ?? unshare.error} />
			</DialogContent>
		</Dialog>
	);
}
