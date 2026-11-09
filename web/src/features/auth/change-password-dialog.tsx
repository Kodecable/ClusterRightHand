import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormDialog } from "@/components/dialogs";
import { CheckboxField, TextField } from "@/components/form";
import { useChangePassword } from "@/features/auth/api";

interface ChangePasswordValues {
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
	revokeApiTokens: boolean;
}

/**
 * The account's password dialog (react-hook-form + zod, doc/webui.md "表单").
 * The three fields are validated locally; the server still checks the current
 * password and its own policy.
 */
export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useLingui();
	const mutation = useChangePassword();

	const schema = useMemo(
		() =>
			z
				.object({
					currentPassword: z.string().min(1, t`Enter your current password.`),
					newPassword: z.string().min(8, t`Use at least 8 characters.`),
					confirmPassword: z.string().min(1, t`Repeat the new password.`),
					revokeApiTokens: z.boolean(),
				})
				.refine((values) => values.newPassword === values.confirmPassword, {
					message: t`The new passwords do not match.`,
					path: ["confirmPassword"],
				}),
		[t],
	);

	const form = useForm<ChangePasswordValues>({
		resolver: zodResolver(schema),
		defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "", revokeApiTokens: false },
	});

	const submit = form.handleSubmit(async (values) => {
		await mutation.mutateAsync(
			{
				currentPassword: values.currentPassword,
				newPassword: values.newPassword,
				revokeApiTokens: values.revokeApiTokens,
			},
			{
				onSuccess: () => {
					toast.success(t`Password changed. Other sign-ins were signed out.`);
					form.reset();
					onOpenChange(false);
				},
			},
		);
	});

	return (
		<FormDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					form.reset();
					mutation.reset();
				}
				onOpenChange(next);
			}}
			title={<Trans>Change password</Trans>}
			description={<Trans>Choose a new password for your account.</Trans>}
			submitLabel={<Trans>Save password</Trans>}
			busy={mutation.isPending}
			error={mutation.error !== null ? mutation.error.message : undefined}
			testId="change-password-dialog"
			onSubmit={() => void submit()}
		>
			<TextField
				control={form.control}
				name="currentPassword"
				type="password"
				autoComplete="current-password"
				label={<Trans>Current password</Trans>}
			/>
			<TextField
				control={form.control}
				name="newPassword"
				type="password"
				autoComplete="new-password"
				label={<Trans>New password</Trans>}
				description={<Trans>At least 8 characters.</Trans>}
			/>
			<TextField
				control={form.control}
				name="confirmPassword"
				type="password"
				autoComplete="new-password"
				label={<Trans>Repeat new password</Trans>}
			/>
			<CheckboxField
				control={form.control}
				name="revokeApiTokens"
				label={<Trans>Also revoke all of my API tokens</Trans>}
				description={
					<Trans>
						Changing the password signs out your other web sessions but does not revoke existing API tokens. Tick this
						to revoke all of them too.
					</Trans>
				}
			/>
		</FormDialog>
	);
}
