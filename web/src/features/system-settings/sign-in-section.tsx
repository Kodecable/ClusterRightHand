import type { SystemSettings } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { SelectField } from "@/components/form";
import { WarningBanner } from "@/components/warning-banner";
import { useSaveSystemSettings } from "./api";
import { applyServerFieldErrors } from "./form";
import { NumberField, SettingsSection } from "./section-form";

/**
 * Sign-in settings: the captcha and the Argon2id hashing limits (doc/guide/reference/crhs-config.md "System settings").
 */
export function SignInSection({ settings, defaults }: { settings: SystemSettings; defaults: SystemSettings }) {
	const { t } = useLingui();
	const save = useSaveSystemSettings();
	const [error, setError] = useState<unknown>();

	const schema = useMemo(
		() =>
			z.object({
				captcha: z.enum(["cap", "none"]),
				argon2Concurrency: z
					.string()
					.refine((value) => /^\d+$/.test(value.trim()) && Number(value) >= 1, t`Enter a whole number of at least 1.`),
				argon2Queue: z
					.string()
					.refine((value) => /^\d+$/.test(value.trim()) && Number(value) >= 0, t`Enter a whole number of 0 or more.`),
			}),
		[t],
	);
	type Values = z.infer<typeof schema>;

	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			captcha: settings.auth.captcha,
			argon2Concurrency: String(settings.auth.argon2Concurrency),
			argon2Queue: String(settings.auth.argon2Queue),
		},
	});
	const captcha = useWatch({ control: form.control, name: "captcha" });

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		try {
			const next = await save.mutateAsync({
				auth: {
					captcha: values.captcha,
					argon2Concurrency: Number(values.argon2Concurrency.trim()),
					argon2Queue: Number(values.argon2Queue.trim()),
				},
			});
			form.reset({
				captcha: next.auth.captcha,
				argon2Concurrency: String(next.auth.argon2Concurrency),
				argon2Queue: String(next.auth.argon2Queue),
			});
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					"auth.captcha": "captcha",
					"auth.argon2Concurrency": "argon2Concurrency",
					"auth.argon2Queue": "argon2Queue",
				}),
			);
		}
	});

	const defaultCaptcha = defaults.auth.captcha;
	const defaultConcurrency = String(defaults.auth.argon2Concurrency);
	const defaultQueue = String(defaults.auth.argon2Queue);

	return (
		<SettingsSection
			title={<Trans>Sign-in</Trans>}
			onSubmit={submit}
			busy={save.isPending}
			dirty={form.formState.isDirty}
			error={error}
			testId="sign-in-section"
		>
			<SelectField
				control={form.control}
				name="captcha"
				label={<Trans>Captcha</Trans>}
				description={<Trans>Whether sign-in requires a proof of work. Default: {defaultCaptcha}.</Trans>}
				options={[
					{ value: "cap", label: <Trans>Cap proof of work</Trans> },
					{ value: "none", label: <Trans>No captcha</Trans> },
				]}
			/>
			{captcha === "none" && (
				<WarningBanner icon>
					<Trans>Without a captcha, sign-in has no proof of work; use it only where no browser is involved.</Trans>
				</WarningBanner>
			)}
			<div className="grid gap-3 sm:grid-cols-2">
				<NumberField
					control={form.control}
					name="argon2Concurrency"
					label={<Trans>Argon2 concurrency</Trans>}
					placeholder={defaultConcurrency}
					min={1}
					description={
						<Trans>Password hashes computed at once; each uses 64 MiB. Default: {defaultConcurrency}.</Trans>
					}
				/>
				<NumberField
					control={form.control}
					name="argon2Queue"
					label={<Trans>Argon2 queue</Trans>}
					placeholder={defaultQueue}
					min={0}
					description={
						<Trans>
							Password hashes allowed to wait; beyond that, requests fail with hash_busy. Default: {defaultQueue}.
						</Trans>
					}
				/>
			</div>
		</SettingsSection>
	);
}
