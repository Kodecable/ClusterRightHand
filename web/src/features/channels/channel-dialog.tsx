import type { ChannelInput, ChannelView } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormDialog } from "@/components/dialogs";
import { CheckboxField, SelectField, TextareaField, TextField } from "@/components/form";
import { useSaveChannel } from "./api";

const NAME_PATTERN = /^[a-z-][a-z0-9-]{0,63}$/;

function channelSchema(
	editing: boolean,
	messages: { name: string; token: string; url: string; platform: string; botId: string },
) {
	return z
		.object({
			name: z.string(),
			kind: z.enum(["telegram", "satori"]),
			token: z.string(),
			enabled: z.boolean(),
			url: z.string(),
			platform: z.string(),
			botId: z.string(),
			linkInstructions: z.string(),
		})
		.superRefine((values, context) => {
			if (!editing && !NAME_PATTERN.test(values.name)) {
				context.addIssue({
					code: "custom",
					path: ["name"],
					message: "Use lowercase letters, digits and -, not starting with a digit.",
				});
			}
			if (!editing && values.kind === "telegram" && values.token.trim() === "") {
				context.addIssue({ code: "custom", path: ["token"], message: messages.token });
			}
			if (values.kind !== "satori") return;
			if (!/^https?:\/\//i.test(values.url.trim())) {
				context.addIssue({ code: "custom", path: ["url"], message: messages.url });
			}
			if (values.platform.trim() === "") {
				context.addIssue({ code: "custom", path: ["platform"], message: messages.platform });
			}
			if (values.botId.trim() === "") {
				context.addIssue({ code: "custom", path: ["botId"], message: messages.botId });
			}
		});
}

type Values = z.infer<ReturnType<typeof channelSchema>>;

/** The administrator's create/edit dialog for one chat bot (doc/design/channels.md "Channels"). */
export function ChannelDialog({ existing, onClose }: { existing: ChannelView | undefined; onClose: () => void }) {
	const { t } = useLingui();
	const save = useSaveChannel();
	const editing = existing !== undefined;
	const schema = useMemo(
		() =>
			channelSchema(editing, {
				name: t`Use lowercase letters, digits and -, not starting with a digit.`,
				token: t`The bot token is required.`,
				url: t`Use an http or https gateway URL.`,
				platform: t`The platform is required.`,
				botId: t`The bot id is required.`,
			}),
		[editing, t],
	);
	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			name: existing?.name ?? "",
			kind: existing?.kind ?? "telegram",
			token: "",
			enabled: existing?.enabled ?? true,
			url: existing?.config?.url ?? "",
			platform: existing?.config?.platform ?? "",
			botId: existing?.config?.botId ?? "",
			linkInstructions: existing?.linkInstructions ?? "",
		},
	});
	const kind = form.watch("kind");
	const satori = kind === "satori";

	const submit = form.handleSubmit((values) => {
		const body: ChannelInput = {
			kind: values.kind,
			enabled: values.enabled,
			...(values.token.trim() === "" ? {} : { token: values.token.trim() }),
			...(values.kind === "satori"
				? {
						config: {
							url: values.url.trim(),
							platform: values.platform.trim(),
							botId: values.botId.trim(),
						},
						linkInstructions: values.linkInstructions.trim() === "" ? null : values.linkInstructions.trim(),
					}
				: {}),
		};
		save.mutate({ name: values.name, body }, { onSuccess: onClose });
	});

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={editing ? t`Edit channel ${existing.name}` : t`New channel`}
			description={
				satori ? (
					<Trans>
						A Satori gateway bot. Private chats only; one bot per channel, with a gateway URL, platform and bot id.
					</Trans>
				) : (
					<Trans>A Telegram bot. Private chats only; a topic is its own session.</Trans>
				)
			}
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
			<SelectField
				control={form.control}
				name="kind"
				label={t`Kind`}
				disabled={editing}
				options={[
					{ value: "telegram", label: "Telegram" },
					{ value: "satori", label: "Satori" },
				]}
			/>
			<TextField
				control={form.control}
				name="token"
				label={satori ? t`Gateway token` : t`Bot token`}
				type="password"
				placeholder={editing && existing.hasCredentials ? t`Leave empty to keep the current token` : undefined}
				description={
					satori ? (
						<Trans>Optional. It is encrypted with the master key and never shown again.</Trans>
					) : (
						<Trans>From BotFather. It is encrypted with the master key and never shown again.</Trans>
					)
				}
			/>
			{satori && (
				<>
					<TextField
						control={form.control}
						name="url"
						label={t`Gateway URL`}
						type="url"
						placeholder="http://koishi:5140/satori"
						description={<Trans>The gateway base URL; its API is under /v1.</Trans>}
					/>
					<TextField
						control={form.control}
						name="platform"
						label={t`Platform`}
						placeholder="telegram"
						description={<Trans>The platform the bot runs on at the gateway.</Trans>}
					/>
					<TextField
						control={form.control}
						name="botId"
						label={t`Bot id`}
						description={
							<Trans>
								The login's user id in that platform; the channels page lists the ones the gateway reported.
							</Trans>
						}
					/>
					<TextareaField
						control={form.control}
						name="linkInstructions"
						label={t`Link instructions`}
						rows={4}
						description={
							<Trans>Plain text shown to users before they link a chat, such as how to reach the bot.</Trans>
						}
					/>
				</>
			)}
			<CheckboxField
				control={form.control}
				name="enabled"
				label={t`Enabled`}
				description={<Trans>Disabled channels stop polling or disconnect.</Trans>}
			/>
		</FormDialog>
	);
}
