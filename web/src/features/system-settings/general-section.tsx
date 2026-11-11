import type { SystemSettings } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { TextField } from "@/components/form";
import { useSaveSystemSettings } from "./api";
import { applyServerFieldErrors, durationMs, isHttpUrl } from "./form";
import { SettingsSection } from "./section-form";

/**
 * General system settings: the public base URL crhs puts in links it returns and
 * the clock-drift warning threshold (doc/guide/reference/crhs-config.md "System settings").
 */
export function GeneralSection({ settings, defaults }: { settings: SystemSettings; defaults: SystemSettings }) {
	const { t } = useLingui();
	const save = useSaveSystemSettings();
	const [error, setError] = useState<unknown>();

	const schema = useMemo(
		() =>
			z.object({
				publicUrl: z
					.string()
					.refine((value) => value.trim() === "" || isHttpUrl(value.trim()), t`Enter an absolute http or https URL.`),
				clockWarn: z.string().refine((value) => durationMs(value) !== null, t`Enter a duration such as 60s or 5m.`),
			}),
		[t],
	);
	type Values = z.infer<typeof schema>;

	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: { publicUrl: settings.publicUrl ?? "", clockWarn: settings.clockWarn },
	});

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		const publicUrl = values.publicUrl.trim();
		try {
			const next = await save.mutateAsync({
				publicUrl: publicUrl === "" ? null : publicUrl,
				clockWarn: values.clockWarn.trim(),
			});
			form.reset({ publicUrl: next.publicUrl ?? "", clockWarn: next.clockWarn });
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					publicUrl: "publicUrl",
					clockWarn: "clockWarn",
				}),
			);
		}
	});

	const defaultClockWarn = defaults.clockWarn;

	return (
		<SettingsSection
			title={<Trans>General</Trans>}
			onSubmit={submit}
			busy={save.isPending}
			dirty={form.formState.isDirty}
			error={error}
			testId="general-section"
		>
			<TextField
				control={form.control}
				name="publicUrl"
				label={<Trans>Public URL</Trans>}
				placeholder="https://crh.example.com"
				description={
					<Trans>
						Used for links crhs returns, e.g. in MCP results. Empty uses the address of the request (the default).
					</Trans>
				}
			/>
			<TextField
				control={form.control}
				name="clockWarn"
				label={<Trans>Clock warning threshold</Trans>}
				placeholder={defaultClockWarn}
				description={
					<Trans>
						Warn when a node's clock differs from crhs's by more than this; 0s disables the warning. Default:{" "}
						{defaultClockWarn}.
					</Trans>
				}
			/>
		</SettingsSection>
	);
}
