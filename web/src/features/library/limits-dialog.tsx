import type { LibraryView } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { ByteSizeInput } from "@/components/byte-size-input";
import { FormDialog } from "@/components/dialogs";
import { FieldShell } from "@/components/form";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/client";
import { useUpdateLibraryLimits } from "./api";

const MAX_LIMIT = 2_147_483_647;

/**
 * An administrator's **Edit limits** dialog (doc/design/webui.md "User and user group pages"). A limit
 * of 0 allows nothing; lowering a limit below the current usage leaves the library as it is, and no
 * write fits until files are deleted.
 */
export function LibraryLimitsDialog({ library, onClose }: { library: LibraryView; onClose: () => void }) {
	const { t } = useLingui();
	const update = useUpdateLibraryLimits(library.ref);
	const [error, setError] = useState<string>();
	const schema = useMemo(() => {
		const sizeMessage = t`Enter a size such as 32M or 1048576.`;
		const size = z
			.number(sizeMessage)
			.int(sizeMessage)
			.min(0, sizeMessage)
			.max(MAX_LIMIT, t`Enter a size of at most ${MAX_LIMIT} bytes.`);
		return z.object({
			files: z.number(t`Enter a whole number between 0 and ${MAX_LIMIT}.`).int().min(0).max(MAX_LIMIT),
			fileBytes: size,
			totalBytes: size,
		});
	}, [t]);
	type Values = z.infer<typeof schema>;
	const form = useForm<Values>({
		resolver: zodResolver(schema),
		defaultValues: {
			files: library.limits.files,
			fileBytes: library.limits.fileBytes,
			totalBytes: library.limits.totalBytes,
		},
	});

	const submit = form.handleSubmit(async (values) => {
		setError(undefined);
		try {
			await update.mutateAsync(values);
			onClose();
		} catch (err) {
			setError(errorMessage(err));
		}
	});

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`Edit limits for ${library.ownerDisplayName || library.ownerName}`}
			description={t`A limit of 0 allows nothing. Lowering a limit below the current usage keeps the files and refuses new writes until files are deleted.`}
			submitLabel={<Trans>Save</Trans>}
			busy={update.isPending}
			error={error}
			onSubmit={() => void submit()}
			testId="library-limits-dialog"
		>
			<FieldShell id="library-limit-files" label={t`Files`} error={form.formState.errors.files?.message}>
				<Input id="library-limit-files" type="number" min={0} {...form.register("files", { valueAsNumber: true })} />
			</FieldShell>
			<FieldShell id="library-limit-file-bytes" label={t`One file`} error={form.formState.errors.fileBytes?.message}>
				<Controller
					control={form.control}
					name="fileBytes"
					render={({ field }) => (
						<ByteSizeInput
							id="library-limit-file-bytes"
							value={field.value}
							onChange={field.onChange}
							onBlur={field.onBlur}
						/>
					)}
				/>
			</FieldShell>
			<FieldShell
				id="library-limit-total-bytes"
				label={t`Total size`}
				error={form.formState.errors.totalBytes?.message}
			>
				<Controller
					control={form.control}
					name="totalBytes"
					render={({ field }) => (
						<ByteSizeInput
							id="library-limit-total-bytes"
							value={field.value}
							onChange={field.onChange}
							onBlur={field.onBlur}
						/>
					)}
				/>
			</FieldShell>
		</FormDialog>
	);
}
