import type { SystemSettings } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { ByteSizeInput } from "@/components/byte-size-input";
import { FieldShell } from "@/components/form";
import { Input } from "@/components/ui/input";
import { useSaveSystemSettings } from "./api";
import { applyServerFieldErrors } from "./form";
import { SettingsSection } from "./section-form";

/**
 * Chat attachment inlining (doc/design/library.md "Chat attachments"): a short text file's content is
 * appended to its own block, and at most a fixed total is inlined per message.
 */
export function AttachmentsSection({ settings }: { settings: SystemSettings }) {
	const { t } = useLingui();
	const save = useSaveSystemSettings();
	const [error, setError] = useState<unknown>();
	const schema = useMemo(() => {
		const sizeMessage = t`Enter a size such as 32M or 1048576.`;
		const size = z.number(sizeMessage).int(sizeMessage).min(0, sizeMessage);
		return z.object({
			inlineTextBytes: size,
			inlineTotalBytes: size,
		});
	}, [t]);
	type Values = z.infer<typeof schema>;
	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			inlineTextBytes: settings.attachments.inlineTextBytes,
			inlineTotalBytes: settings.attachments.inlineTotalBytes,
		},
	});

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		try {
			const next = await save.mutateAsync({ attachments: values });
			form.reset(next.attachments);
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					"attachments.inlineTextBytes": "inlineTextBytes",
					"attachments.inlineTotalBytes": "inlineTotalBytes",
				}),
			);
		}
	});

	return (
		<SettingsSection
			title={<Trans>Chat attachments</Trans>}
			description={
				<Trans>
					A text file up to the per-file limit has its content appended to its message block; no more than the
					per-message limit is inlined over one message. Images are never inlined.
				</Trans>
			}
			onSubmit={submit}
			busy={save.isPending}
			dirty={form.formState.isDirty}
			error={error}
			testId="attachments-section"
		>
			<FieldShell
				id="attachments-inline-text-bytes"
				label={t`Largest file to inline`}
				error={form.formState.errors.inlineTextBytes?.message}
			>
				<Controller
					control={form.control}
					name="inlineTextBytes"
					render={({ field }) => (
						<ByteSizeInput
							id="attachments-inline-text-bytes"
							value={field.value}
							onChange={field.onChange}
							onBlur={field.onBlur}
						/>
					)}
				/>
			</FieldShell>
			<FieldShell
				id="attachments-inline-total-bytes"
				label={t`Most inlined per message`}
				error={form.formState.errors.inlineTotalBytes?.message}
			>
				<Controller
					control={form.control}
					name="inlineTotalBytes"
					render={({ field }) => (
						<ByteSizeInput
							id="attachments-inline-total-bytes"
							value={field.value}
							onChange={field.onChange}
							onBlur={field.onBlur}
						/>
					)}
				/>
			</FieldShell>
		</SettingsSection>
	);
}

/** The image cache's size and time to live (doc/design/library.md "Image cache"). */
export function ImageCacheSection({ settings }: { settings: SystemSettings }) {
	const { t } = useLingui();
	const save = useSaveSystemSettings();
	const [error, setError] = useState<unknown>();
	const schema = useMemo(() => {
		const sizeMessage = t`Enter a size such as 32M or 1048576.`;
		return z.object({
			diskBytes: z.number(sizeMessage).int(sizeMessage).min(0, sizeMessage),
			ttl: z.string().trim().min(1, t`Enter a duration such as 7d.`),
		});
	}, [t]);
	type Values = z.infer<typeof schema>;
	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			diskBytes: settings.imageCache.diskBytes,
			ttl: settings.imageCache.ttl,
		},
	});

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		try {
			const next = await save.mutateAsync({
				imageCache: { diskBytes: values.diskBytes, ttl: values.ttl },
			});
			form.reset(next.imageCache);
		} catch (failure) {
			setError(
				applyServerFieldErrors<Values>(failure, form.setError, {
					"imageCache.diskBytes": "diskBytes",
					"imageCache.ttl": "ttl",
				}),
			);
		}
	});

	return (
		<SettingsSection
			title={<Trans>Image cache</Trans>}
			description={
				<Trans>
					The bytes behind view_image results, kept in a disposable directory on crhs's local disk. Entries are evicted
					least recently used, and dropped after the time to live.
				</Trans>
			}
			onSubmit={submit}
			busy={save.isPending}
			dirty={form.formState.isDirty}
			error={error}
			testId="image-cache-section"
		>
			<FieldShell
				id="image-cache-disk-bytes"
				label={t`Cache size on disk`}
				error={form.formState.errors.diskBytes?.message}
			>
				<Controller
					control={form.control}
					name="diskBytes"
					render={({ field }) => (
						<ByteSizeInput
							id="image-cache-disk-bytes"
							value={field.value}
							onChange={field.onChange}
							onBlur={field.onBlur}
						/>
					)}
				/>
			</FieldShell>
			<FieldShell id="image-cache-ttl" label={t`Time to live`} error={form.formState.errors.ttl?.message}>
				<Input id="image-cache-ttl" placeholder={t`7d`} {...form.register("ttl")} />
			</FieldShell>
		</SettingsSection>
	);
}
