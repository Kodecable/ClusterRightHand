import { zodResolver } from "@hookform/resolvers/zod";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { KeySquareIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CodeText } from "@/components/code-text";
import { CopyButton } from "@/components/copy-button";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { TextField } from "@/components/form";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { TokenStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ApiTokenView, Preset, Rule } from "@/lib/api/types";
import { useApiTokens, useCreateApiToken, useDeleteApiToken, useRevokeApiToken, useSetTokenRules } from "./api";
import { mcpCommand, tokenStatus } from "./tokenStatus";

const EXPIRY_OPTIONS = ["30", "90", "365", "never"] as const;

const EXPIRY_LABELS: Record<(typeof EXPIRY_OPTIONS)[number], MessageDescriptor> = {
	"30": msg`30 days`,
	"90": msg`90 days`,
	"365": msg`365 days`,
	never: msg`Never`,
};

function presetHelpKey(preset: Preset): "ask" | "yolo" | "auto_review" {
	return preset;
}

function PresetHelp({ preset }: { preset: Preset }) {
	switch (presetHelpKey(preset)) {
		case "ask":
			return (
				<Trans>
					Ask: ordinary reads run, everything else (including every privileged task) waits for your approval.
				</Trans>
			);
		case "auto_review":
			return (
				<Trans>
					Auto Review: approvals first go to the review model; anything risky still waits for your approval.
				</Trans>
			);
		case "yolo":
			return <Trans>Yolo: everything runs without asking.</Trans>;
	}
}

interface CreateTokenValues {
	name: string;
	preset: Preset;
	days: string;
}

/** The "Create API token" dialog; the secret is shown once, in this component's state only. */
export function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
	const { t } = useLingui();
	const prefix = useId();
	const create = useCreateApiToken();
	const [created, setCreated] = useState<string>();
	const schema = useMemo(
		() =>
			z.object({
				name: z.string().trim().min(1, t`A name is required.`).max(100, t`The name must be at most 100 characters.`),
				preset: z.enum(["ask", "auto_review", "yolo"]),
				days: z.string(),
			}),
		[t],
	);
	const form = useForm<CreateTokenValues>({
		resolver: zodResolver(schema),
		defaultValues: { name: "", preset: "ask", days: "90" },
	});
	const preset = form.watch("preset");
	const days = form.watch("days");
	const command = created ? mcpCommand(window.location.origin, created) : "";

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-lg" data-testid="create-token-dialog">
				{created !== undefined ? (
					<>
						<DialogHeader>
							<DialogTitle>
								<Trans>Token created</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>Copy this token now. It will not be shown again.</Trans>
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-3">
							<section aria-label={t`API token`}>
								<CodeText text={created} maxLines={2} label={t`API token`} copy={false} />
							</section>
							<div>
								<CopyButton text={created} label={t`Copy token`} showLabel variant="outline" />
							</div>
							<p className="text-sm">
								<Trans>Connect Claude Code with:</Trans>
							</p>
							<section aria-label={t`Claude Code command`}>
								<CodeText text={command} maxLines={3} label={t`Claude Code command`} copy={false} />
							</section>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<CopyButton text={command} label={t`Copy command`} showLabel variant="outline" />
								<Button type="button" onClick={onClose}>
									<Trans>Done</Trans>
								</Button>
							</div>
						</div>
					</>
				) : (
					<form
						className="grid gap-3"
						onSubmit={form.handleSubmit((values) => {
							create.mutate(
								{
									name: values.name.trim(),
									preset: values.preset,
									days: values.days === "never" ? null : Number(values.days),
								},
								{
									onSuccess: (result) => {
										setCreated(result.token);
										onCreated();
									},
									onError: (error) => toast.error(error.message),
								},
							);
						})}
					>
						<DialogHeader>
							<DialogTitle>
								<Trans>Create API token</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>Each token has its own rules; what they do not allow waits for your approval.</Trans>
							</DialogDescription>
						</DialogHeader>
						<TextField control={form.control} name="name" label={t`Name`} placeholder={t`Claude Code on the laptop`} />
						<div className="grid gap-1.5">
							<Label htmlFor={`${prefix}-preset`}>{t`Preset`}</Label>
							<Select value={preset} onValueChange={(next) => form.setValue("preset", next as Preset)}>
								<SelectTrigger id={`${prefix}-preset`} className="w-full">
									<SelectValue>
										{(current: string | null) =>
											current === "yolo" ? "Yolo" : current === "auto_review" ? "Auto Review" : "Ask"
										}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="ask">Ask</SelectItem>
									<SelectItem value="auto_review">Auto Review</SelectItem>
									<SelectItem value="yolo">Yolo</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								<PresetHelp preset={preset} />
							</p>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor={`${prefix}-expiry`}>{t`Expires after`}</Label>
							<Select value={days} onValueChange={(next) => form.setValue("days", String(next))}>
								<SelectTrigger id={`${prefix}-expiry`} className="w-full">
									<SelectValue>
										{(current: string | null) =>
											current !== null && current in EXPIRY_LABELS
												? t(EXPIRY_LABELS[current as keyof typeof EXPIRY_LABELS])
												: ""
										}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{EXPIRY_OPTIONS.map((option) => (
										<SelectItem key={option} value={option}>
											{t(EXPIRY_LABELS[option])}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						{days === "never" && (
							<p className="text-sm text-warn">
								<Trans>A token that never expires stays valid until you revoke it.</Trans>
							</p>
						)}
						{preset === "yolo" && (
							<p className="text-sm text-warn">
								<Trans>Yolo lets this token run anything on your nodes without asking.</Trans>
							</p>
						)}
						{create.error !== null && (
							<p role="alert" className="text-sm text-danger">
								{create.error.message}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<Button type="button" variant="outline" onClick={onClose}>
								<Trans>Cancel</Trans>
							</Button>
							<Button type="submit" disabled={create.isPending}>
								<Trans>Create token</Trans>
							</Button>
						</div>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

function RulesDialog({ token, onClose }: { token: ApiTokenView; onClose: () => void }) {
	const { t } = useLingui();
	const prefix = useId();
	const save = useSetTokenRules();
	const [preset, setPreset] = useState<Preset>(token.rules?.preset ?? "ask");
	const [text, setText] = useState(() => JSON.stringify({ rules: token.rules?.rules ?? [] }, null, 2));
	const [error, setError] = useState<string>();

	const parseRules = (): Rule[] | undefined => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (failure) {
			setError(t`Not valid JSON: ${failure instanceof Error ? failure.message : String(failure)}`);
			return undefined;
		}
		const rules = (parsed as { rules?: unknown } | null)?.rules;
		if (!Array.isArray(rules)) {
			setError(t`Expected an object like {"rules": [...]}.`);
			return undefined;
		}
		setError(undefined);
		return rules as Rule[];
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-xl" data-testid="token-rules-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Rules of {token.name}</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>What this token may do without approval; anything else waits for you.</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3">
					<div className="flex flex-wrap items-end gap-2">
						<div className="grid gap-1.5">
							<Label htmlFor={`${prefix}-preset`}>{t`Preset`}</Label>
							<Select value={preset} onValueChange={(next) => setPreset(next as Preset)}>
								<SelectTrigger id={`${prefix}-preset`} className="w-40">
									<SelectValue>
										{(current: string | null) =>
											current === "yolo" ? "Yolo" : current === "auto_review" ? "Auto Review" : "Ask"
										}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="ask">Ask</SelectItem>
									<SelectItem value="auto_review">Auto Review</SelectItem>
									<SelectItem value="yolo">Yolo</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<Button
							type="button"
							variant="outline"
							disabled={save.isPending || preset === token.rules?.preset}
							onClick={() =>
								save.mutate(
									{ id: token.id, body: { preset } },
									{
										onSuccess: () => toast.success(t`Preset saved.`),
										onError: (failure) => toast.error(failure.message),
									},
								)
							}
						>
							<Trans>Save preset</Trans>
						</Button>
						<span className="text-xs text-muted-foreground">
							<PresetHelp preset={preset} />
						</span>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor={`${prefix}-rules`}>{t`Added rules (JSON)`}</Label>
						<Textarea
							id={`${prefix}-rules`}
							rows={10}
							className="font-mono text-xs"
							value={text}
							onChange={(event) => setText(event.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							<Trans>
								Each rule: action (allow, deny, require-approval), optional method (exec, file.read, file.write), nodes,
								and exact or prefix.
							</Trans>
						</p>
					</div>
					{error !== undefined && (
						<p role="alert" className="text-sm text-danger">
							{error}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							<Trans>Close</Trans>
						</Button>
						<Button
							type="button"
							disabled={save.isPending}
							onClick={() => {
								const rules = parseRules();
								if (rules === undefined) return;
								save.mutate(
									{ id: token.id, body: { rules } },
									{
										onSuccess: () => {
											toast.success(t`Rules saved.`);
											onClose();
										},
										onError: (failure) => toast.error(failure.message),
									},
								);
							}}
						>
							<Trans>Save rules</Trans>
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * API tokens (doc/mcp.md): create once-shown secrets, edit the preset and the
 * extra rules, revoke an active token or delete an inactive one.
 */
export function TokensPage() {
	const { t } = useLingui();
	const tokens = useApiTokens();
	const revoke = useRevokeApiToken();
	const remove = useDeleteApiToken();
	const [creating, setCreating] = useState(false);
	const [rules, setRules] = useState<ApiTokenView>();
	const [revoking, setRevoking] = useState<ApiTokenView>();
	const [deleting, setDeleting] = useState<ApiTokenView>();

	const columns = useMemo<DataTableColumn<ApiTokenView>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				cell: ({ row }) => <span className="truncate font-medium">{row.original.name}</span>,
			},
			{
				id: "preset",
				header: t`Preset`,
				size: 110,
				cell: ({ row }) => <span className="text-xs">{row.original.rules?.preset ?? "–"}</span>,
			},
			{
				id: "created",
				header: t`Created`,
				size: 150,
				cell: ({ row }) => <DateTime value={row.original.createdAt} />,
			},
			{
				id: "expires",
				header: t`Expires`,
				size: 150,
				cell: ({ row }) =>
					row.original.expiresAt === null ? (
						<Badge variant="secondary">
							<Trans>never</Trans>
						</Badge>
					) : (
						<DateTime value={row.original.expiresAt} />
					),
			},
			{
				id: "lastUsed",
				header: t`Last used`,
				size: 150,
				cell: ({ row }) => <DateTime value={row.original.lastUsedAt} />,
			},
			{
				id: "status",
				header: t`Status`,
				size: 110,
				cell: ({ row }) => <TokenStatusBadge status={tokenStatus(row.original)} />,
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 200,
				cell: ({ row }) => {
					const token = row.original;
					const status = tokenStatus(token);
					return status === "active" ? (
						<span className="flex flex-nowrap items-center gap-1">
							<Button type="button" size="xs" variant="outline" onClick={() => setRules(token)}>
								<Trans>Rules</Trans>
							</Button>
							<Button type="button" size="xs" variant="destructive" onClick={() => setRevoking(token)}>
								<Trans>Revoke</Trans>
							</Button>
						</span>
					) : (
						<Button type="button" size="xs" variant="destructive" onClick={() => setDeleting(token)}>
							<Trash2Icon />
							<Trans>Delete</Trans>
						</Button>
					);
				},
			},
		],
		[t],
	);

	return (
		<Page data-testid="tokens-page">
			<PageHeader
				title={<Trans>API tokens</Trans>}
				description={
					<Trans>
						API tokens let tools such as Claude Code use your nodes through MCP. Each token has its own rules; what they
						do not allow waits for your approval.
					</Trans>
				}
				actions={
					<Button type="button" onClick={() => setCreating(true)} data-testid="create-token">
						<PlusIcon />
						<Trans>Create token</Trans>
					</Button>
				}
			/>
			<DataTable
				label={t`API tokens`}
				columns={columns}
				data={tokens.data ?? []}
				getRowId={(token) => token.id}
				loading={tokens.isLoading}
				error={tokens.isError ? tokens.error : undefined}
				onRetry={() => void tokens.refetch()}
				empty={
					<EmptyState
						icon={<KeySquareIcon className="size-6" />}
						title={<Trans>No API tokens yet</Trans>}
						description={<Trans>Create a token to connect an MCP client.</Trans>}
					/>
				}
			/>
			{creating && <CreateTokenDialog onClose={() => setCreating(false)} onCreated={() => void tokens.refetch()} />}
			{rules && <RulesDialog token={rules} onClose={() => setRules(undefined)} />}
			<ConfirmDialog
				open={revoking !== undefined}
				onOpenChange={(open) => {
					if (!open) setRevoking(undefined);
				}}
				title={revoking ? t`Revoke token ${revoking.name}?` : ""}
				description={<Trans>Anything using this token stops working immediately. This cannot be undone.</Trans>}
				confirmLabel={<Trans>Revoke token</Trans>}
				busy={revoke.isPending}
				onConfirm={() => {
					if (!revoking) return;
					revoke.mutate(revoking.id, {
						onSuccess: () => {
							toast.success(t`Token revoked.`);
							setRevoking(undefined);
						},
						onError: (error) => toast.error(error.message),
					});
				}}
			/>
			<ConfirmDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleting(undefined);
				}}
				title={deleting ? t`Delete token ${deleting.name}?` : ""}
				description={<Trans>Its audit trail stays; the token itself is removed.</Trans>}
				confirmLabel={<Trans>Delete token</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.id, {
						onSuccess: () => {
							toast.success(t`Token deleted.`);
							setDeleting(undefined);
						},
						onError: (error) => toast.error(error.message),
					});
				}}
			/>
		</Page>
	);
}
