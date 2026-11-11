import type { SystemSettings } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, XIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { FieldShell, TextField } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WarningBanner } from "@/components/warning-banner";
import { useSaveSystemSettings } from "./api";
import { applyServerFieldErrors, isOrigin } from "./form";
import { SettingsSection } from "./section-form";

/** A message from a react-hook-form error, including an array field's root error. */
function errorMessage(error: unknown): string | undefined {
	if (typeof error === "string") return error;
	if (error !== null && typeof error === "object") {
		const record = error as { message?: unknown; root?: unknown };
		if (typeof record.message === "string") return record.message;
		return errorMessage(record.root);
	}
	return undefined;
}

/**
 * Passkey (WebAuthn) settings (doc/guide/reference/crhs-config.md "System settings"): the
 * relying party ID and display name, and the origins allowed to use Passkeys.
 */
export function PasskeysSection({ settings, defaults }: { settings: SystemSettings; defaults: SystemSettings }) {
	const { t } = useLingui();
	const save = useSaveSystemSettings();
	const [error, setError] = useState<unknown>();
	const prefix = useId();

	const schema = useMemo(
		() =>
			z
				.object({
					rpId: z.string(),
					rpName: z.string().refine((value) => value.trim() !== "", t`Enter a display name.`),
					origins: z.array(z.object({ value: z.string() })),
				})
				.superRefine((values, context) => {
					const rpId = values.rpId.trim();
					const origins = values.origins.map((origin) => origin.value.trim()).filter((value) => value !== "");
					if ((rpId === "") !== (origins.length === 0)) {
						context.addIssue({
							code: "custom",
							path: ["rpId"],
							message: t`Set the RP ID and at least one allowed origin together, or leave both empty.`,
						});
					}
					values.origins.forEach((origin, index) => {
						const value = origin.value.trim();
						if (value === "" || isOrigin(value)) return;
						context.addIssue({
							code: "custom",
							path: ["origins", index, "value"],
							message: t`Enter an origin such as https://crh.example.com.`,
						});
					});
				}),
		[t],
	);
	type Values = z.infer<typeof schema>;

	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			rpId: settings.webauthn.rpId ?? "",
			rpName: settings.webauthn.rpName,
			origins: settings.webauthn.origins.map((value) => ({ value })),
		},
	});
	const origins = useFieldArray({ control: form.control, name: "origins" });
	const originsRootError = errorMessage(form.formState.errors.origins);
	const originsId = `${prefix}-origins`;

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		const rpId = values.rpId.trim();
		const allowedOrigins = values.origins.map((origin) => origin.value.trim()).filter((origin) => origin !== "");
		try {
			const next = await save.mutateAsync({
				webauthn: {
					rpId: rpId === "" ? null : rpId,
					rpName: values.rpName.trim(),
					origins: rpId === "" ? [] : allowedOrigins,
				},
			});
			form.reset({
				rpId: next.webauthn.rpId ?? "",
				rpName: next.webauthn.rpName,
				origins: next.webauthn.origins.map((value) => ({ value })),
			});
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					"webauthn.rpId": "rpId",
					"webauthn.rpName": "rpName",
					"webauthn.origins": "origins",
				}),
			);
		}
	});

	const defaultRpName = defaults.webauthn.rpName;

	return (
		<SettingsSection
			title={<Trans>Passkeys</Trans>}
			onSubmit={submit}
			busy={save.isPending}
			dirty={form.formState.isDirty}
			error={error}
			testId="passkeys-section"
		>
			<WarningBanner icon>
				<Trans>Changing the RP ID invalidates the Passkeys registered for the old one.</Trans>
			</WarningBanner>
			<div className="grid gap-3 sm:grid-cols-2">
				<TextField
					control={form.control}
					name="rpId"
					label={<Trans>Relying party ID</Trans>}
					placeholder="crh.example.com"
					description={
						<Trans>
							The hostname Passkeys are registered for, such as crh.example.com. Empty derives it from each request; set
							it together with the allowed origins. Default: unset.
						</Trans>
					}
				/>
				<TextField
					control={form.control}
					name="rpName"
					label={<Trans>Display name</Trans>}
					placeholder={defaultRpName}
					description={<Trans>Name shown by the authenticator. Default: {defaultRpName}.</Trans>}
				/>
			</div>
			<FieldShell
				id={originsId}
				label={<Trans>Allowed origins</Trans>}
				description={
					<Trans>
						Origins allowed to use Passkeys, such as https://crh.example.com. Empty derives them from each request.
					</Trans>
				}
				error={originsRootError}
			>
				<div className="grid gap-2">
					{origins.fields.map((field, index) => {
						const itemError = errorMessage(form.formState.errors.origins?.[index]?.value);
						return (
							<div key={field.id} className="grid gap-1">
								<div className="flex items-center gap-2">
									<Input
										aria-label={t`Allowed origin ${index + 1}`}
										placeholder="https://crh.example.com"
										aria-invalid={itemError !== undefined || undefined}
										{...form.register(`origins.${index}.value`)}
									/>
									<Button
										type="button"
										variant="outline"
										size="icon-sm"
										aria-label={t`Remove origin ${index + 1}`}
										onClick={() => origins.remove(index)}
									>
										<XIcon />
									</Button>
								</div>
								{itemError !== undefined && (
									<p role="alert" className="text-xs text-danger">
										{itemError}
									</p>
								)}
							</div>
						);
					})}
					<div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => origins.append({ value: "" })}
							data-testid="add-origin"
						>
							<PlusIcon />
							<Trans>Add origin</Trans>
						</Button>
					</div>
				</div>
			</FieldShell>
		</SettingsSection>
	);
}
