import type { SystemSettings } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useMemo, useState } from "react";
import { type Control, type FieldPath, type FieldValues, useController, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { FieldShell, SelectField, TextField } from "@/components/form";
import { Input } from "@/components/ui/input";
import { WarningBanner } from "@/components/warning-banner";
import { useSaveSystemSettings } from "./api";
import { applyServerFieldErrors, isHeaderName } from "./form";
import { SettingsSection } from "./section-form";

/** A whole-number field kept as text while editing, so an empty box is a validation error, not 0. */
function NumberField<T extends FieldValues>({
	control,
	name,
	label,
	description,
	placeholder,
	min,
}: {
	control: Control<T>;
	name: FieldPath<T>;
	label: React.ReactNode;
	description?: React.ReactNode;
	placeholder?: string;
	min: number;
}) {
	const id = useId();
	const { field, fieldState } = useController({ control, name });
	const error = fieldState.error?.message;
	return (
		<FieldShell id={id} label={label} description={description} error={error}>
			<Input
				id={id}
				type="number"
				inputMode="numeric"
				min={min}
				step={1}
				placeholder={placeholder}
				name={field.name}
				ref={field.ref}
				value={typeof field.value === "string" ? field.value : ""}
				onChange={(event) => field.onChange(event.target.value)}
				onBlur={field.onBlur}
				aria-invalid={error !== undefined || undefined}
				aria-describedby={description !== undefined ? `${id}-description` : undefined}
			/>
		</FieldShell>
	);
}

/**
 * Sign-in settings: the captcha, the header carrying the real client address and the
 * Argon2id hashing limits (doc/guide/reference/crhs-config.md "System settings").
 */
export function SignInSection({ settings, defaults }: { settings: SystemSettings; defaults: SystemSettings }) {
	const { t } = useLingui();
	const save = useSaveSystemSettings();
	const [error, setError] = useState<unknown>();

	const schema = useMemo(
		() =>
			z.object({
				captcha: z.enum(["cap", "none"]),
				realIpHeader: z
					.string()
					.refine(
						(value) => value.trim() === "" || isHeaderName(value.trim()),
						t`Enter an HTTP header name such as X-Forwarded-For.`,
					),
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
			realIpHeader: settings.realIpHeader ?? "",
			argon2Concurrency: String(settings.auth.argon2Concurrency),
			argon2Queue: String(settings.auth.argon2Queue),
		},
	});
	const captcha = useWatch({ control: form.control, name: "captcha" });
	const realIpHeader = useWatch({ control: form.control, name: "realIpHeader" });

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		const header = values.realIpHeader.trim();
		try {
			const next = await save.mutateAsync({
				auth: {
					captcha: values.captcha,
					argon2Concurrency: Number(values.argon2Concurrency.trim()),
					argon2Queue: Number(values.argon2Queue.trim()),
				},
				realIpHeader: header === "" ? null : header,
			});
			form.reset({
				captcha: next.auth.captcha,
				realIpHeader: next.realIpHeader ?? "",
				argon2Concurrency: String(next.auth.argon2Concurrency),
				argon2Queue: String(next.auth.argon2Queue),
			});
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					"auth.captcha": "captcha",
					"auth.argon2Concurrency": "argon2Concurrency",
					"auth.argon2Queue": "argon2Queue",
					realIpHeader: "realIpHeader",
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
			<TextField
				control={form.control}
				name="realIpHeader"
				label={<Trans>Real client IP header</Trans>}
				placeholder="X-Forwarded-For"
				description={
					<Trans>
						Take the client address from this header's first value. Empty uses the connection's address (the default).
					</Trans>
				}
			/>
			{realIpHeader.trim() !== "" && (
				<WarningBanner icon>
					<Trans>
						Your reverse proxy must overwrite this header, and crhs must not be reachable directly; otherwise clients
						can choose their own address.
					</Trans>
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
