import type { SystemSettings } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { CheckboxField, SelectField, TextField } from "@/components/form";
import { useSaveSystemSettings } from "./api";
import { applyServerFieldErrors, durationMs } from "./form";
import { SettingsSection } from "./section-form";

/** The intervals the server accepts (doc/design/metrics.md "Settings"). */
const INTERVALS = ["15", "20", "30", "60"] as const;

/**
 * Host metrics collection (doc/design/metrics.md "Settings"): the switch, the sample interval and the
 * retention of the four storage levels. The server checks the minimum per level and their order; a
 * rejected value is shown on its own field.
 */
export function MetricsSection({ settings, defaults }: { settings: SystemSettings; defaults: SystemSettings }) {
	const { t, i18n } = useLingui();
	const save = useSaveSystemSettings();
	const [error, setError] = useState<unknown>();

	const schema = useMemo(() => {
		const durationMessage = t`Enter a duration such as 24h or 7d.`;
		const duration = z.string().refine((value) => {
			const ms = durationMs(value);
			return ms !== null && ms > 0;
		}, durationMessage);
		return z.object({
			enabled: z.boolean(),
			interval: z.enum(INTERVALS),
			l1: duration,
			l2: duration,
			l3: duration,
			l4: duration,
		});
	}, [t]);
	type Values = z.infer<typeof schema>;

	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			enabled: settings.metrics.enabled,
			interval: String(settings.metrics.interval) as Values["interval"],
			l1: settings.metrics.retention.l1,
			l2: settings.metrics.retention.l2,
			l3: settings.metrics.retention.l3,
			l4: settings.metrics.retention.l4,
		},
	});

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		try {
			const next = await save.mutateAsync({
				metrics: {
					enabled: values.enabled,
					interval: Number(values.interval),
					retention: {
						l1: values.l1.trim(),
						l2: values.l2.trim(),
						l3: values.l3.trim(),
						l4: values.l4.trim(),
					},
				},
			});
			form.reset({
				enabled: next.metrics.enabled,
				interval: String(next.metrics.interval) as Values["interval"],
				l1: next.metrics.retention.l1,
				l2: next.metrics.retention.l2,
				l3: next.metrics.retention.l3,
				l4: next.metrics.retention.l4,
			});
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					"metrics.enabled": "enabled",
					"metrics.interval": "interval",
					"metrics.retention.l1": "l1",
					"metrics.retention.l2": "l2",
					"metrics.retention.l3": "l3",
					"metrics.retention.l4": "l4",
				}),
			);
		}
	});

	return (
		<SettingsSection
			title={<Trans>Metrics</Trans>}
			description={
				<Trans>
					Host metrics from every node: CPU, load, memory, swap, filesystems, network and availability. Turning
					collection off stops the samples; stored metrics stay until their retention removes them.
				</Trans>
			}
			onSubmit={submit}
			busy={save.isPending}
			dirty={form.formState.isDirty}
			error={error}
			testId="metrics-section"
		>
			<CheckboxField
				control={form.control}
				name="enabled"
				label={<Trans>Collect host metrics</Trans>}
				description={<Trans>Default: {defaults.metrics.enabled ? t`on` : t`off`}.</Trans>}
			/>
			<SelectField
				control={form.control}
				name="interval"
				label={<Trans>Sample interval</Trans>}
				description={<Trans>Seconds between samples. A changed interval applies from the next tick.</Trans>}
				options={INTERVALS.map((seconds) => ({
					value: seconds,
					label: i18n._(msg`${seconds} seconds`),
				}))}
			/>
			<div className="grid gap-3 sm:grid-cols-2">
				<TextField
					control={form.control}
					name="l1"
					label={<Trans>Keep 1-minute buckets</Trans>}
					placeholder={defaults.metrics.retention.l1}
					description={<Trans>At least 10 minutes. Default: {defaults.metrics.retention.l1}.</Trans>}
				/>
				<TextField
					control={form.control}
					name="l2"
					label={<Trans>Keep 5-minute buckets</Trans>}
					placeholder={defaults.metrics.retention.l2}
					description={
						<Trans>
							At least 50 minutes, and at least as long as level 1. Default: {defaults.metrics.retention.l2}.
						</Trans>
					}
				/>
				<TextField
					control={form.control}
					name="l3"
					label={<Trans>Keep 1-hour buckets</Trans>}
					placeholder={defaults.metrics.retention.l3}
					description={
						<Trans>At least 10 hours, and at least as long as level 2. Default: {defaults.metrics.retention.l3}.</Trans>
					}
				/>
				<TextField
					control={form.control}
					name="l4"
					label={<Trans>Keep 1-day buckets</Trans>}
					placeholder={defaults.metrics.retention.l4}
					description={
						<Trans>At least 10 days, and at least as long as level 3. Default: {defaults.metrics.retention.l4}.</Trans>
					}
				/>
			</div>
		</SettingsSection>
	);
}
