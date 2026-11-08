import type { RulePreset } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { CodeText } from "@/components/code-text";
import { CopyButton } from "@/components/copy-button";
import { FormDialog } from "@/components/dialogs";
import { TextField } from "@/components/form";
import { RulePresetSelect } from "@/components/rule-preset-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateApiToken } from "./api";
import { RulePresetHelp } from "./rule-preset-help";
import { mcpCommand } from "./tokenStatus";

const EXPIRY_OPTIONS = ["30", "90", "365", "never"] as const;

const EXPIRY_LABELS: Record<(typeof EXPIRY_OPTIONS)[number], MessageDescriptor> = {
	"30": msg`30 days`,
	"90": msg`90 days`,
	"365": msg`365 days`,
	never: msg`Never`,
};

interface CreateTokenValues {
	name: string;
	rulePreset: RulePreset;
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
				rulePreset: z.enum(["ask", "auto_review", "yolo"]),
				days: z.string(),
			}),
		[t],
	);
	const form = useForm<CreateTokenValues>({
		resolver: zodResolver(schema),
		defaultValues: { name: "", rulePreset: "ask", days: "90" },
	});
	const rulePreset = form.watch("rulePreset");
	const days = form.watch("days");
	const command = created ? mcpCommand(window.location.origin, created) : "";
	const submit = form.handleSubmit((values) => {
		create.mutate(
			{
				name: values.name.trim(),
				rulePreset: values.rulePreset,
				days: values.days === "never" ? null : Number(values.days),
			},
			{
				onSuccess: (result) => {
					setCreated(result.token);
					onCreated();
				},
			},
		);
	});

	if (created !== undefined) {
		return (
			<Dialog
				open
				onOpenChange={(open) => {
					if (!open) onClose();
				}}
			>
				<DialogContent className="sm:max-w-lg" data-testid="create-token-dialog">
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
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Create API token</Trans>}
			description={<Trans>Each token has its own rules; what they do not allow waits for your approval.</Trans>}
			submitLabel={<Trans>Create token</Trans>}
			busy={create.isPending}
			error={create.error !== null ? create.error.message : undefined}
			testId="create-token-dialog"
			className="sm:max-w-lg"
			onSubmit={() => void submit()}
		>
			<TextField control={form.control} name="name" label={t`Name`} placeholder={t`Claude Code on the laptop`} />
			<div className="grid gap-1.5">
				<Label htmlFor={`${prefix}-rulePreset`}>{t`Rule preset`}</Label>
				<RulePresetSelect
					id={`${prefix}-rulePreset`}
					value={rulePreset}
					onChange={(next) => form.setValue("rulePreset", next)}
				/>
				<p className="text-xs text-muted-foreground">
					<RulePresetHelp rulePreset={rulePreset} />
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
			{rulePreset === "yolo" && (
				<p className="text-sm text-warn">
					<Trans>Yolo lets this token run anything on your nodes without asking.</Trans>
				</p>
			)}
		</FormDialog>
	);
}
