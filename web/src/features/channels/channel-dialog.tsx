import type { ChannelView, RulePreset } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormDialog } from "@/components/dialogs";
import { CheckboxField, SelectField, TextField } from "@/components/form";
import { useAvailableModels, useSaveChannel } from "./api";

const NAME_PATTERN = /^[a-z-][a-z0-9-]{0,63}$/;

function channelSchema(editing: boolean, messages: { name: string; token: string }) {
	return z
		.object({
			name: z.string(),
			token: z.string(),
			model: z.string(),
			rulePreset: z.string(),
			enabled: z.boolean(),
		})
		.superRefine((values, context) => {
			if (!editing && !NAME_PATTERN.test(values.name)) {
				context.addIssue({
					code: "custom",
					path: ["name"],
					message: "Use lowercase letters, digits and -, not starting with a digit.",
				});
			}
			if (!editing && values.token.trim() === "") {
				context.addIssue({ code: "custom", path: ["token"], message: messages.token });
			}
		});
}

type Values = z.infer<ReturnType<typeof channelSchema>>;

/** The administrator's create/edit dialog for one Telegram bot (doc/design/channels.md "Channels"). */
export function ChannelDialog({ existing, onClose }: { existing: ChannelView | undefined; onClose: () => void }) {
	const { t } = useLingui();
	const models = useAvailableModels();
	const save = useSaveChannel();
	const editing = existing !== undefined;
	const schema = useMemo(
		() =>
			channelSchema(editing, {
				name: t`Use lowercase letters, digits and -, not starting with a digit.`,
				token: t`The bot token is required.`,
			}),
		[editing, t],
	);
	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			name: existing?.name ?? "",
			token: "",
			model:
				existing?.defaultModel === null || existing?.defaultModel === undefined
					? ""
					: `${existing.defaultModel.provider}/${existing.defaultModel.modelId}`,
			rulePreset: existing?.defaultRulePreset ?? "",
			enabled: existing?.enabled ?? true,
		},
	});
	const modelOptions = [
		{ value: "", label: t`System default` },
		...(models.data ?? []).map((model) => ({
			value: `${model.provider}/${model.modelId}`,
			label: `${model.name} (${model.provider})`,
		})),
	];
	const ruleOptions = [
		{ value: "", label: t`Ask (default)` },
		{ value: "ask", label: t`Ask` },
		{ value: "auto_review", label: t`Auto Review` },
		{ value: "yolo", label: t`Yolo` },
	];

	const submit = form.handleSubmit((values) => {
		const slash = values.model.indexOf("/");
		save.mutate(
			{
				name: values.name,
				body: {
					kind: "telegram",
					enabled: values.enabled,
					...(values.token.trim() === "" ? {} : { token: values.token.trim() }),
					defaultModel:
						values.model === ""
							? null
							: {
									provider: values.model.slice(0, slash),
									modelId: values.model.slice(slash + 1),
								},
					defaultRulePreset: values.rulePreset === "" ? null : (values.rulePreset as RulePreset),
				},
			},
			{ onSuccess: onClose },
		);
	});

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={editing ? t`Edit channel ${existing.name}` : t`New channel`}
			description={<Trans>A Telegram bot. Private chats only; a topic is its own session.</Trans>}
			onSubmit={submit}
			submitLabel={editing ? <Trans>Save</Trans> : <Trans>Create channel</Trans>}
			busy={save.isPending}
			error={save.error?.message}
			testId="channel-dialog"
			className="max-w-xl"
		>
			<TextField
				control={form.control}
				name="name"
				label={t`Name`}
				description={<Trans>Lowercase letters, digits and -, not starting with a digit.</Trans>}
				disabled={editing}
			/>
			<TextField
				control={form.control}
				name="token"
				label={t`Bot token`}
				type="password"
				placeholder={editing && existing.hasCredentials ? t`Leave empty to keep the current token` : undefined}
				description={<Trans>From BotFather. It is encrypted with the master key and never shown again.</Trans>}
			/>
			<SelectField control={form.control} name="model" label={t`Default model`} options={modelOptions} />
			<SelectField control={form.control} name="rulePreset" label={t`Default rule preset`} options={ruleOptions} />
			<CheckboxField
				control={form.control}
				name="enabled"
				label={t`Enabled`}
				description={<Trans>Disabled channels stop polling.</Trans>}
			/>
		</FormDialog>
	);
}
