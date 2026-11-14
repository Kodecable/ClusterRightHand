import type { SystemSettings } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { ByteSizeInput } from "@/components/byte-size-input";
import { FieldShell } from "@/components/form";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/format";
import { useSaveSystemSettings } from "./api";
import { applyServerFieldErrors } from "./form";
import { SettingsSection } from "./section-form";

const MAX_LIMIT = 2_147_483_647;

/**
 * The default limits new libraries copy (doc/design/webui.md "System settings page" and
 * doc/design/library.md "Limits"). Changing them does not touch an existing library.
 */
export function LibraryDefaultsSection({ settings, defaults }: { settings: SystemSettings; defaults: SystemSettings }) {
	const { t, i18n } = useLingui();
	const save = useSaveSystemSettings();
	const [error, setError] = useState<unknown>();
	const schema = useMemo(() => {
		const limit = z.number(t`Enter a whole number between 0 and ${MAX_LIMIT}.`).int().min(0).max(MAX_LIMIT);
		const sizeMessage = t`Enter a size such as 32M or 1048576.`;
		const size = z
			.number(sizeMessage)
			.int(sizeMessage)
			.min(0, sizeMessage)
			.max(MAX_LIMIT, t`Enter a size of at most ${MAX_LIMIT} bytes.`);
		return z.object({
			userFiles: limit,
			userFileBytes: size,
			userTotalBytes: size,
			groupFiles: limit,
			groupFileBytes: size,
			groupTotalBytes: size,
		});
	}, [t]);
	type Values = z.infer<typeof schema>;
	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			userFiles: settings.library.user.files,
			userFileBytes: settings.library.user.fileBytes,
			userTotalBytes: settings.library.user.totalBytes,
			groupFiles: settings.library.group.files,
			groupFileBytes: settings.library.group.fileBytes,
			groupTotalBytes: settings.library.group.totalBytes,
		},
	});

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		try {
			const next = await save.mutateAsync({
				library: {
					user: {
						files: values.userFiles,
						fileBytes: values.userFileBytes,
						totalBytes: values.userTotalBytes,
					},
					group: {
						files: values.groupFiles,
						fileBytes: values.groupFileBytes,
						totalBytes: values.groupTotalBytes,
					},
				},
			});
			form.reset({
				userFiles: next.library.user.files,
				userFileBytes: next.library.user.fileBytes,
				userTotalBytes: next.library.user.totalBytes,
				groupFiles: next.library.group.files,
				groupFileBytes: next.library.group.fileBytes,
				groupTotalBytes: next.library.group.totalBytes,
			});
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					"library.user.files": "userFiles",
					"library.user.fileBytes": "userFileBytes",
					"library.user.totalBytes": "userTotalBytes",
					"library.group.files": "groupFiles",
					"library.group.fileBytes": "groupFileBytes",
					"library.group.totalBytes": "groupTotalBytes",
				}),
			);
		}
	});

	return (
		<SettingsSection
			title={<Trans>Library defaults</Trans>}
			description={
				<Trans>
					The limits a new user or user group library copies when it is created. Changing them applies only to libraries
					created later.
				</Trans>
			}
			onSubmit={submit}
			busy={save.isPending}
			dirty={form.formState.isDirty}
			error={error}
			testId="library-defaults-section"
		>
			<fieldset className="grid gap-3">
				<legend className="text-sm font-medium">
					<Trans>New user libraries</Trans>
				</legend>
				<p className="-mt-2 text-sm text-muted-foreground">
					<Trans>Defaults: {formatBytes(defaults.library.user.totalBytes, i18n.locale)} total.</Trans>
				</p>
				<FieldShell
					id="library-user-files"
					label={t`Files for new users`}
					error={form.formState.errors.userFiles?.message}
				>
					<Input
						id="library-user-files"
						type="number"
						min={0}
						{...form.register("userFiles", { valueAsNumber: true })}
					/>
				</FieldShell>
				<FieldShell
					id="library-user-file-bytes"
					label={t`One file for new users`}
					error={form.formState.errors.userFileBytes?.message}
				>
					<Controller
						control={form.control}
						name="userFileBytes"
						render={({ field }) => (
							<ByteSizeInput
								id="library-user-file-bytes"
								value={field.value}
								onChange={field.onChange}
								onBlur={field.onBlur}
							/>
						)}
					/>
				</FieldShell>
				<FieldShell
					id="library-user-total-bytes"
					label={t`Total size for new users`}
					error={form.formState.errors.userTotalBytes?.message}
				>
					<Controller
						control={form.control}
						name="userTotalBytes"
						render={({ field }) => (
							<ByteSizeInput
								id="library-user-total-bytes"
								value={field.value}
								onChange={field.onChange}
								onBlur={field.onBlur}
							/>
						)}
					/>
				</FieldShell>
			</fieldset>
			<fieldset className="grid gap-3">
				<legend className="text-sm font-medium">
					<Trans>New user group libraries</Trans>
				</legend>
				<p className="-mt-2 text-sm text-muted-foreground">
					<Trans>
						A limit of 0 allows nothing, so a new user group library is unusable until an administrator raises its
						limits.
					</Trans>
				</p>
				<FieldShell
					id="library-group-files"
					label={t`Files for new groups`}
					error={form.formState.errors.groupFiles?.message}
				>
					<Input
						id="library-group-files"
						type="number"
						min={0}
						{...form.register("groupFiles", { valueAsNumber: true })}
					/>
				</FieldShell>
				<FieldShell
					id="library-group-file-bytes"
					label={t`One file for new groups`}
					error={form.formState.errors.groupFileBytes?.message}
				>
					<Controller
						control={form.control}
						name="groupFileBytes"
						render={({ field }) => (
							<ByteSizeInput
								id="library-group-file-bytes"
								value={field.value}
								onChange={field.onChange}
								onBlur={field.onBlur}
							/>
						)}
					/>
				</FieldShell>
				<FieldShell
					id="library-group-total-bytes"
					label={t`Total size for new groups`}
					error={form.formState.errors.groupTotalBytes?.message}
				>
					<Controller
						control={form.control}
						name="groupTotalBytes"
						render={({ field }) => (
							<ByteSizeInput
								id="library-group-total-bytes"
								value={field.value}
								onChange={field.onChange}
								onBlur={field.onBlur}
							/>
						)}
					/>
				</FieldShell>
			</fieldset>
		</SettingsSection>
	);
}
