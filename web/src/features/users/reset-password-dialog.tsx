import { zodResolver } from "@hookform/resolvers/zod";
import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormDialog } from "@/components/dialogs";
import { CheckboxField, TextField } from "@/components/form";
import type { User } from "@/lib/api/types";
import { useSetUserPassword } from "./api";

/** An administrator's password reset for another account, optionally ending its API tokens. */
export function ResetPasswordDialog({ user, onClose }: { user: User; onClose: () => void }) {
	const { t } = useLingui();
	const setPasswordMutation = useSetUserPassword();
	const schema = useMemo(
		() =>
			z.object({
				password: z.string().min(8, t`Use at least 8 characters.`),
				revokeApiTokens: z.boolean(),
			}),
		[t],
	);
	const form = useForm<{ password: string; revokeApiTokens: boolean }>({
		resolver: zodResolver(schema),
		defaultValues: { password: "", revokeApiTokens: false },
	});
	const submit = form.handleSubmit((values) => {
		setPasswordMutation.mutate(
			{ id: user.id, password: values.password, revokeApiTokens: values.revokeApiTokens },
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
			<CheckboxField
				control={form.control}
				name="revokeApiTokens"
				label={t`Also revoke all of this user's API tokens`}
				description={t`Changing the password signs out the user's web sessions but does not revoke their existing API tokens. Tick this to revoke all of them too.`}
			/>
		</FormDialog>
	);
}
