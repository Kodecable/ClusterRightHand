import { Trans, useLingui } from "@lingui/react/macro";
import { Link2Icon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { DateTime } from "@/components/relative-time";
import { SectionHeader } from "@/components/section";
import { StatusText } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MONO_CELL } from "@/lib/utils";
import {
	useChannelAccounts,
	useChannelSettings,
	useCreateLinkCode,
	useSaveChannelSettings,
	useUnlinkAccount,
} from "./api";

/**
 * A user's own chat accounts (doc/design/channels.md "Accounts"): link a private chat with a one-time code,
 * unlink it, choose the default notification account and toggle progress.
 */
export function ChatAccountsSection() {
	const { t } = useLingui();
	const accounts = useChannelAccounts();
	const settings = useChannelSettings();
	const createCode = useCreateLinkCode();
	const unlink = useUnlinkAccount();
	const saveSettings = useSaveChannelSettings();
	const [codeOpen, setCodeOpen] = useState(false);
	const channel = accounts.data?.channels[0];
	const rows = accounts.data?.accounts ?? [];
	const defaultAccountId = settings.data?.defaultAccountId ?? null;

	const create = () => {
		createCode.mutate(channel?.id, { onSuccess: () => setCodeOpen(true) });
	};

	return (
		<section className="grid gap-2" aria-labelledby="chat-accounts-heading" data-testid="chat-accounts">
			<SectionHeader
				id="chat-accounts-heading"
				title={<Trans>Linked accounts</Trans>}
				actions={
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={create}
						disabled={channel === undefined || createCode.isPending}
						data-testid="create-link-code"
					>
						<PlusIcon />
						<Trans>Create link code</Trans>
					</Button>
				}
			/>
			<p className="text-sm text-muted-foreground">
				<Trans>
					Link a private chat to use your sessions and approvals from chat. A linked chat acts with your authority;
					protect it like your password.
				</Trans>
			</p>
			{rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					{channel === undefined ? (
						<Trans>No chat channel is set up; ask an administrator.</Trans>
					) : (
						<Trans>No chat account is linked yet.</Trans>
					)}
				</p>
			) : (
				<ul className="grid gap-2" data-testid="chat-account-list">
					{rows.map((account) => (
						<li key={account.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
							<span className="grid gap-0.5">
								<span className="flex items-center gap-2 text-sm">
									<Link2Icon className="size-3.5" />
									<span className="font-medium">{account.displayName ?? account.platformUserId}</span>
									<code className={MONO_CELL}>{account.channelName}</code>
									{account.isDefault && (
										<StatusText tone="info">
											<Trans>Default</Trans>
										</StatusText>
									)}
								</span>
								<span className="text-xs text-muted-foreground">
									<Trans>
										{account.platform} · linked <DateTime value={account.linkedAt} />
									</Trans>
								</span>
							</span>
							<Button
								type="button"
								size="xs"
								variant="destructive"
								disabled={unlink.isPending}
								aria-label={t`Unlink ${account.displayName ?? account.platformUserId}`}
								onClick={() => unlink.mutate(account.id)}
							>
								<Trans>Unlink</Trans>
							</Button>
						</li>
					))}
				</ul>
			)}

			<div className="grid gap-2 sm:grid-cols-2">
				<div className="grid gap-1">
					<Label htmlFor="default-chat-account">
						<Trans>Default notification account</Trans>
					</Label>
					<Select
						value={defaultAccountId ?? "none"}
						onValueChange={(value) => saveSettings.mutate({ defaultAccountId: value === "none" ? null : value })}
						disabled={rows.length === 0 || saveSettings.isPending}
					>
						<SelectTrigger id="default-chat-account" className="w-full">
							<SelectValue>
								{(selected: string | null) => {
									if (selected === null || selected === "none") return t`None (WebUI only)`;
									const account = rows.find((row) => row.id === selected);
									return account === undefined
										? t`None (WebUI only)`
										: `${account.displayName ?? account.platformUserId} (${account.channelName})`;
								}}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">{t`None (WebUI only)`}</SelectItem>
							{rows.map((account) => (
								<SelectItem key={account.id} value={account.id}>
									{account.displayName ?? account.platformUserId} ({account.channelName})
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						<Trans>Where notifications go when you are not using the WebUI.</Trans>
					</p>
				</div>
				<div className="flex items-start gap-2 pt-5">
					<Checkbox
						id="chat-show-progress"
						checked={settings.data?.showProgress ?? true}
						onCheckedChange={(checked) => saveSettings.mutate({ showProgress: Boolean(checked) })}
						disabled={saveSettings.isPending}
					/>
					<div className="grid gap-0.5">
						<Label htmlFor="chat-show-progress">
							<Trans>Show progress</Trans>
						</Label>
						<p className="text-xs text-muted-foreground">
							<Trans>
								Show the current step while a turn runs; tool calls and thinking are never sent as messages.
							</Trans>
						</p>
					</div>
				</div>
			</div>

			<Dialog open={codeOpen} onOpenChange={setCodeOpen}>
				<DialogContent data-testid="link-code-dialog">
					<DialogHeader>
						<DialogTitle>
							<Trans>Link this chat</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Send the command below to the bot in a private chat. The code works once and expires in 10 minutes.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					{createCode.data !== undefined && (
						<div className="grid gap-2">
							<code className="rounded-md border bg-muted p-3 font-mono text-sm" data-testid="link-code">
								/link {createCode.data.code}
							</code>
							<p className="text-sm text-muted-foreground">
								{channel?.account === null || channel?.account === undefined ? (
									<Trans>Open a private chat with the bot named {channel?.name}.</Trans>
								) : (
									<Trans>Open a private chat with @{channel.account}.</Trans>
								)}{" "}
								<Trans>
									Expires <DateTime value={createCode.data.expiresAt} />.
								</Trans>
							</p>
						</div>
					)}
					<DialogFooter>
						<Button type="button" onClick={() => setCodeOpen(false)}>
							<Trans>Done</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}
