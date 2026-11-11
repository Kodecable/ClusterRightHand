import type { SystemSettings } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useMemo, useState } from "react";
import { type Control, type FieldPath, type FieldValues, useController, useForm } from "react-hook-form";
import { z } from "zod";
import { FieldShell } from "@/components/form";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSaveSystemSettings } from "./api";
import { applyServerFieldErrors, isRetentionDuration } from "./form";
import { SettingsSection } from "./section-form";

/**
 * One retention window: a duration input, or the "Keep forever" checkbox that
 * stores the server's `"off"`.
 */
function RetentionField<T extends FieldValues>({
	control,
	name,
	label,
	defaultValue,
}: {
	control: Control<T>;
	name: FieldPath<T>;
	label: React.ReactNode;
	defaultValue: string;
}) {
	const { t } = useLingui();
	const id = useId();
	const foreverId = `${id}-forever`;
	const { field, fieldState } = useController({ control, name });
	const error = fieldState.error?.message;
	const forever = field.value === "off";
	return (
		<FieldShell id={id} label={label} description={<Trans>Default: {defaultValue}.</Trans>} error={error}>
			<div className="flex flex-wrap items-center gap-3">
				<Input
					id={id}
					name={field.name}
					ref={field.ref}
					className="w-40"
					placeholder={defaultValue}
					disabled={forever}
					value={forever ? "" : typeof field.value === "string" ? field.value : ""}
					onChange={(event) => field.onChange(event.target.value)}
					onBlur={field.onBlur}
					aria-invalid={error !== undefined || undefined}
					aria-describedby={`${id}-description`}
				/>
				<div className="flex items-center gap-2">
					<Checkbox
						id={foreverId}
						checked={forever}
						onCheckedChange={(checked) => field.onChange(checked ? "off" : defaultValue)}
					/>
					<Label htmlFor={foreverId} className="font-normal">
						{t`Keep forever`}
					</Label>
				</div>
			</div>
		</FieldShell>
	);
}

/**
 * Data retention (doc/guide/reference/crhs-config.md "System settings"): how long finished
 * tasks and authorizations, audit events and agent tool records are kept.
 */
export function RetentionSection({ settings, defaults }: { settings: SystemSettings; defaults: SystemSettings }) {
	const { t } = useLingui();
	const save = useSaveSystemSettings();
	const [error, setError] = useState<unknown>();

	const schema = useMemo(() => {
		const retention = z
			.string()
			.refine(
				(value) => value === "off" || isRetentionDuration(value),
				t`Enter a duration of at least 1 day, or choose Keep forever.`,
			);
		return z.object({ tasks: retention, audit: retention, piTasks: retention });
	}, [t]);
	type Values = z.infer<typeof schema>;

	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			tasks: settings.retention.tasks,
			audit: settings.retention.audit,
			piTasks: settings.retention.piTasks,
		},
	});

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		try {
			const next = await save.mutateAsync({
				retention: {
					tasks: values.tasks.trim(),
					audit: values.audit.trim(),
					piTasks: values.piTasks.trim(),
				},
			});
			form.reset(next.retention);
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					"retention.tasks": "tasks",
					"retention.audit": "audit",
					"retention.piTasks": "piTasks",
				}),
			);
		}
	});

	return (
		<SettingsSection
			title={<Trans>Data retention</Trans>}
			description={
				<Trans>How long crhs keeps records after they finish. A duration of at least one day, or Keep forever.</Trans>
			}
			onSubmit={submit}
			busy={save.isPending}
			dirty={form.formState.isDirty}
			error={error}
			testId="retention-section"
		>
			<RetentionField
				control={form.control}
				name="tasks"
				label={<Trans>Tasks</Trans>}
				defaultValue={defaults.retention.tasks}
			/>
			<RetentionField
				control={form.control}
				name="audit"
				label={<Trans>Audit events</Trans>}
				defaultValue={defaults.retention.audit}
			/>
			<RetentionField
				control={form.control}
				name="piTasks"
				label={<Trans>Agent tool records</Trans>}
				defaultValue={defaults.retention.piTasks}
			/>
		</SettingsSection>
	);
}
