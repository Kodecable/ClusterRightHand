import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/dialogs";
import { ErrorText } from "@/components/error-state";
import { ModelSelect } from "@/components/model-select";
import { RulePresetSelect } from "@/components/rule-preset-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateSession } from "@/features/sessions/api";
import { useModels } from "@/features/settings/api";
import { errorMessage } from "@/lib/api/client";
import type { ModelRef, RulePreset } from "@/lib/api/types";
import { parseQuotaInput, type QuotaError } from "@/lib/quota";

/**
 * "New session" (doc/webui.md "侧边列表"): title, model, rule preset and a token
 * quota (empty = unlimited). A yolo rule preset is called out because it lets the
 * agent act without asking.
 */
export function NewSessionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const models = useModels();
	const create = useCreateSession();
	const [title, setTitle] = useState("");
	const [model, setModel] = useState<ModelRef | undefined>(undefined);
	const [rulePreset, setRulePreset] = useState<RulePreset>("ask");
	const [quotaText, setQuotaText] = useState("");
	const [quotaError, setQuotaError] = useState<QuotaError>();

	const available = models.data ?? [];
	const noModels = models.data !== undefined && available.length === 0;
	const chosen =
		model ?? (available[0] ? { provider: available[0].provider, modelId: available[0].modelId } : undefined);

	const quotaErrorText = (error: QuotaError): string => {
		switch (error) {
			case "whole-number":
				return t`Enter a whole number of tokens, or leave it empty for unlimited.`;
			case "too-large":
				return t`That number is too large.`;
			case "positive-required":
				return t`Enter a positive number of tokens to add.`;
		}
	};

	const submit = async () => {
		if (!chosen) return;
		const quota = parseQuotaInput(quotaText);
		if ("error" in quota) {
			setQuotaError(quota.error);
			return;
		}
		setQuotaError(undefined);
		try {
			const session = await create.mutateAsync({
				...(title.trim() !== "" ? { title: title.trim() } : {}),
				model: chosen,
				rulePreset,
				budgetRemaining: quota.quota,
			});
			toast.success(t`Session created.`);
			onOpenChange(false);
			setTitle("");
			setQuotaText("");
			void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } });
		} catch {
			// The mutation's error is rendered below.
		}
	};

	return (
		<FormDialog
			open={open}
			onOpenChange={onOpenChange}
			title={<Trans>New session</Trans>}
			description={<Trans>Start a conversation with the agent; it acts on your nodes through the same rules.</Trans>}
			submitLabel={<Trans>Create session</Trans>}
			onSubmit={() => void submit()}
			busy={create.isPending}
			error={
				create.error !== null
					? errorMessage(create.error)
					: quotaError !== undefined
						? quotaErrorText(quotaError)
						: undefined
			}
		>
			<div className="grid gap-1.5">
				<Label htmlFor="new-session-title">
					<Trans>Title</Trans>
				</Label>
				<Input
					id="new-session-title"
					value={title}
					maxLength={200}
					placeholder={t`New session`}
					onChange={(event) => setTitle(event.target.value)}
				/>
			</div>

			<div className="grid gap-1.5">
				<Label htmlFor="new-session-model">
					<Trans>Model</Trans>
				</Label>
				<ModelSelect id="new-session-model" models={available} value={chosen} onChange={setModel} />
			</div>

			<div className="grid gap-1.5">
				<Label htmlFor="new-session-rule-preset">
					<Trans>Rule preset</Trans>
				</Label>
				<RulePresetSelect id="new-session-rule-preset" value={rulePreset} onChange={setRulePreset} />
			</div>

			<div className="grid gap-1.5">
				<Label htmlFor="new-session-quota">
					<Trans>Token budget (empty = unlimited)</Trans>
				</Label>
				<Input
					id="new-session-quota"
					inputMode="numeric"
					value={quotaText}
					placeholder={t`Unlimited`}
					onChange={(event) => setQuotaText(event.target.value)}
				/>
			</div>

			{rulePreset === "yolo" && (
				<p className="text-xs text-warn" role="status">
					<Trans>Yolo lets the agent run anything on your nodes without asking.</Trans>
				</p>
			)}
			{noModels && (
				<p className="text-xs text-warn" role="status">
					<Trans>No models are configured, so sessions cannot start. Ask an administrator to configure one.</Trans>
				</p>
			)}
			<ErrorText error={models.error} />
		</FormDialog>
	);
}
