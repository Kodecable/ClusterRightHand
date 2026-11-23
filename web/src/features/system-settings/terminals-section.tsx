import type { SystemSettings } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { ByteSizeInput } from "@/components/byte-size-input";
import { CheckboxField, FieldShell, TextField } from "@/components/form";
import { Input } from "@/components/ui/input";
import { terminalKeys } from "@/features/terminals/api";
import { formatBytes } from "@/lib/format";
import { useSaveSystemSettings } from "./api";
import { applyServerFieldErrors, durationMs } from "./form";
import { SettingsSection } from "./section-form";

/** crha's scrollback bounds (doc/design/pty.md "Settings and limits"). */
const MIN_SCROLLBACK_BYTES = 64 * 1024;
const MAX_SCROLLBACK_BYTES = 16 * 1024 * 1024;

/**
 * The terminal subsystem's settings (doc/design/pty.md "Settings and limits"): the switch, the limits on
 * how many terminals exist, the largest timeouts an agent may ask for and crha's scrollback ring.
 */
export function TerminalsSection({ settings, defaults }: { settings: SystemSettings; defaults: SystemSettings }) {
	const { t, i18n } = useLingui();
	const save = useSaveSystemSettings();
	const queryClient = useQueryClient();
	const [error, setError] = useState<unknown>();

	const schema = useMemo(() => {
		const countMessage = t`Enter a whole number, 0 or more.`;
		const count = z.number(countMessage).int(countMessage).min(0, countMessage);
		const durationMessage = t`Enter a duration such as 1h or 10m.`;
		const duration = z.string().refine((value) => {
			const ms = durationMs(value);
			return ms !== null && ms > 0;
		}, durationMessage);
		const bytesMessage = t`Enter a size from 64K to 16M, such as 1M.`;
		const bytes = z
			.number(bytesMessage)
			.int(bytesMessage)
			.min(MIN_SCROLLBACK_BYTES, bytesMessage)
			.max(MAX_SCROLLBACK_BYTES, bytesMessage);
		return z.object({
			enabled: z.boolean(),
			maxPerNode: count,
			maxTotal: count,
			maxPerSession: count,
			agentIdleTimeoutMax: duration,
			watchTimeoutMax: duration,
			scrollbackBytes: bytes,
		});
	}, [t]);
	type Values = z.infer<typeof schema>;

	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			enabled: settings.pty.enabled,
			maxPerNode: settings.pty.maxPerNode,
			maxTotal: settings.pty.maxTotal,
			maxPerSession: settings.pty.maxPerSession,
			agentIdleTimeoutMax: settings.pty.agentIdleTimeoutMax,
			watchTimeoutMax: settings.pty.watchTimeoutMax,
			scrollbackBytes: settings.pty.scrollbackBytes,
		},
	});

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		try {
			const next = await save.mutateAsync({
				pty: {
					enabled: values.enabled,
					maxPerNode: values.maxPerNode,
					maxTotal: values.maxTotal,
					maxPerSession: values.maxPerSession,
					agentIdleTimeoutMax: values.agentIdleTimeoutMax.trim(),
					watchTimeoutMax: values.watchTimeoutMax.trim(),
					scrollbackBytes: values.scrollbackBytes,
				},
			});
			form.reset(next.pty);
			// Turning the subsystem off hides the nav entry and the page without a reload.
			void queryClient.invalidateQueries({ queryKey: terminalKeys.enabled() });
			void queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					"pty.enabled": "enabled",
					"pty.maxPerNode": "maxPerNode",
					"pty.maxTotal": "maxTotal",
					"pty.maxPerSession": "maxPerSession",
					"pty.agentIdleTimeoutMax": "agentIdleTimeoutMax",
					"pty.watchTimeoutMax": "watchTimeoutMax",
					"pty.scrollbackBytes": "scrollbackBytes",
				}),
			);
		}
	});

	return (
		<SettingsSection
			title={<Trans>Terminals</Trans>}
			description={
				<Trans>
					The interactive terminal subsystem. Turning it off closes every terminal and hides the Terminals page and the
					agent tools.
				</Trans>
			}
			onSubmit={submit}
			busy={save.isPending}
			dirty={form.formState.isDirty}
			error={error}
			testId="terminals-section"
		>
			<CheckboxField
				control={form.control}
				name="enabled"
				label={<Trans>Enable terminals</Trans>}
				description={<Trans>Default: {defaults.pty.enabled ? t`on` : t`off`}.</Trans>}
			/>
			<div className="grid gap-3 sm:grid-cols-3">
				<FieldShell
					id="pty-max-per-node"
					label={t`Terminals per node`}
					description={<Trans>Default: {defaults.pty.maxPerNode}.</Trans>}
					error={form.formState.errors.maxPerNode?.message}
				>
					<Input
						id="pty-max-per-node"
						type="number"
						min={0}
						aria-invalid={form.formState.errors.maxPerNode !== undefined || undefined}
						{...form.register("maxPerNode", { valueAsNumber: true })}
					/>
				</FieldShell>
				<FieldShell
					id="pty-max-total"
					label={t`Terminals in total`}
					description={<Trans>Default: {defaults.pty.maxTotal}.</Trans>}
					error={form.formState.errors.maxTotal?.message}
				>
					<Input
						id="pty-max-total"
						type="number"
						min={0}
						aria-invalid={form.formState.errors.maxTotal !== undefined || undefined}
						{...form.register("maxTotal", { valueAsNumber: true })}
					/>
				</FieldShell>
				<FieldShell
					id="pty-max-per-session"
					label={t`Terminals per session`}
					description={<Trans>Default: {defaults.pty.maxPerSession}.</Trans>}
					error={form.formState.errors.maxPerSession?.message}
				>
					<Input
						id="pty-max-per-session"
						type="number"
						min={0}
						aria-invalid={form.formState.errors.maxPerSession !== undefined || undefined}
						{...form.register("maxPerSession", { valueAsNumber: true })}
					/>
				</FieldShell>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<TextField
					control={form.control}
					name="agentIdleTimeoutMax"
					label={<Trans>Longest agent idle timeout</Trans>}
					placeholder={defaults.pty.agentIdleTimeoutMax}
					description={
						<Trans>
							The longest idle timeout an agent may ask for when it opens a terminal. Default:{" "}
							{defaults.pty.agentIdleTimeoutMax}.
						</Trans>
					}
				/>
				<TextField
					control={form.control}
					name="watchTimeoutMax"
					label={<Trans>Longest watch timeout</Trans>}
					placeholder={defaults.pty.watchTimeoutMax}
					description={
						<Trans>The longest an agent's terminal watch may block. Default: {defaults.pty.watchTimeoutMax}.</Trans>
					}
				/>
			</div>
			<FieldShell
				id="pty-scrollback-bytes"
				label={t`Scrollback per terminal`}
				description={
					<Trans>
						crha's ring buffer for a terminal's output, between 64K and 16M. Default:{" "}
						{formatBytes(defaults.pty.scrollbackBytes, i18n.locale)}.
					</Trans>
				}
				error={form.formState.errors.scrollbackBytes?.message}
			>
				<Controller
					control={form.control}
					name="scrollbackBytes"
					render={({ field }) => (
						<ByteSizeInput
							id="pty-scrollback-bytes"
							value={field.value}
							onChange={field.onChange}
							onBlur={field.onBlur}
							aria-invalid={form.formState.errors.scrollbackBytes !== undefined || undefined}
						/>
					)}
				/>
			</FieldShell>
		</SettingsSection>
	);
}
