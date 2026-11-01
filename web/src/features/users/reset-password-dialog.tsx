import { zodResolver } from "@hookform/resolvers/zod";
import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormDialog } from "@/components/dialogs";
import { TextField } from "@/components/form";
import type { User } from "@/lib/api/types";
import { useSetUserPassword } from "./api";

/** An administrator's one-field password reset for another account. */
export function ResetPasswordDialog({ user, onClose }: { user: User; onClose: () => void }) {
	const { t } = useLingui();
	const setPasswordMutation = useSetUserPassword();
	const schema = useMemo(() => z.object({ password: z.string().min(8, t`Use at least 8 characters.`) }), [t]);
	const form = useForm<{ password: string }>({
		resolver: zodResolver(schema),
		defaultValues: { password: "" },
	});
	const submit = form.handleSubmit((values) => {
		setPasswordMutation.mutate(
			{ id: user.id, password: values.password },
			{
				onSuccess: () => {
					toast.success(t`Password set.`);
					onClose();
				},
			},
		);
	});
	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`Reset the password of ${user.username}`}
			description={t`The user can sign in with this password immediately.`}
			busy={setPasswordMutation.isPending}
			submitLabel={t`Set password`}
			onSubmit={() => void submit()}
		>
			<TextField
				control={form.control}
				name="password"
				type="password"
				label={t`New password`}
				autoComplete="new-password"
				description={t`At least 8 characters.`}
			/>
		</FormDialog>
	);
}
