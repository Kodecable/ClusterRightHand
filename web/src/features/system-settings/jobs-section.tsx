import type { SystemSettings } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useSaveSystemSettings } from "./api";
import { applyServerFieldErrors } from "./form";
import { NumberField, SettingsSection } from "./section-form";

/**
 * The job limits (doc/design/jobs.md "Completion notices" and "Lifecycle and retention"):
 * how often completion notices may wake a session and how many jobs it may leave unsettled.
 */
export function JobsSection({ settings, defaults }: { settings: SystemSettings; defaults: SystemSettings }) {
	const { t } = useLingui();
	const save = useSaveSystemSettings();
	const [error, setError] = useState<unknown>();

	const schema = useMemo(() => {
		const message = t`Enter a whole number of 0 or more.`;
		const count = z.string().refine((value) => /^\d+$/.test(value.trim()) && Number(value) >= 0, message);
		return z.object({ maxConsecutiveWakes: count, maxRunning: count });
	}, [t]);
	type Values = z.infer<typeof schema>;

	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			maxConsecutiveWakes: String(settings.jobs.maxConsecutiveWakes),
			maxRunning: String(settings.jobs.maxRunning),
		},
	});

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		try {
			const next = await save.mutateAsync({
				jobs: {
					maxConsecutiveWakes: Number(values.maxConsecutiveWakes.trim()),
					maxRunning: Number(values.maxRunning.trim()),
				},
			});
			form.reset({
				maxConsecutiveWakes: String(next.jobs.maxConsecutiveWakes),
				maxRunning: String(next.jobs.maxRunning),
			});
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					"jobs.maxConsecutiveWakes": "maxConsecutiveWakes",
					"jobs.maxRunning": "maxRunning",
				}),
			);
		}
	});

	return (
		<SettingsSection
			title={<Trans>Jobs</Trans>}
			onSubmit={submit}
			busy={save.isPending}
			dirty={form.formState.isDirty}
			error={error}
			testId="jobs-section"
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<NumberField
					control={form.control}
					name="maxConsecutiveWakes"
					label={<Trans>Completion notice wakes</Trans>}
					placeholder={String(defaults.jobs.maxConsecutiveWakes)}
					min={0}
					description={
						<Trans>
							Most times completion notices may wake a session since its last message a user typed; 0 turns notice wakes
							off. Default: {defaults.jobs.maxConsecutiveWakes}.
						</Trans>
					}
				/>
				<NumberField
					control={form.control}
					name="maxRunning"
					label={<Trans>Jobs per session</Trans>}
					placeholder={String(defaults.jobs.maxRunning)}
					min={0}
					description={
						<Trans>
							Most unsettled jobs a session, or an API token over MCP, may have at once; 0 allows none. Default:{" "}
							{defaults.jobs.maxRunning}.
						</Trans>
					}
				/>
			</div>
		</SettingsSection>
	);
}
