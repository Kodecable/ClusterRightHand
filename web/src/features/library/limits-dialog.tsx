import type { LibraryView } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
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
	const schema = useMemo(
		() =>
			z.object({
				files: z.number(t`Enter a whole number between 0 and ${MAX_LIMIT}.`).int().min(0).max(MAX_LIMIT),
				fileBytes: z.number(t`Enter a whole number between 0 and ${MAX_LIMIT}.`).int().min(0).max(MAX_LIMIT),
				totalBytes: z.number(t`Enter a whole number between 0 and ${MAX_LIMIT}.`).int().min(0).max(MAX_LIMIT),
			}),
		[t],
	);
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
			<FieldShell
				id="library-limit-file-bytes"
				label={t`One file (bytes)`}
				error={form.formState.errors.fileBytes?.message}
			>
				<Input
					id="library-limit-file-bytes"
					type="number"
					min={0}
					{...form.register("fileBytes", { valueAsNumber: true })}
				/>
			</FieldShell>
			<FieldShell
				id="library-limit-total-bytes"
				label={t`Total size (bytes)`}
				error={form.formState.errors.totalBytes?.message}
			>
				<Input
					id="library-limit-total-bytes"
					type="number"
					min={0}
					{...form.register("totalBytes", { valueAsNumber: true })}
				/>
			</FieldShell>
		</FormDialog>
	);
}
