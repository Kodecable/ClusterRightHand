import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ErrorText } from "@/components/error-state";
import { TextField } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useChangePassword } from "@/features/auth/api";

interface ChangePasswordValues {
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
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
				})
				.refine((values) => values.newPassword === values.confirmPassword, {
					message: t`The new passwords do not match.`,
					path: ["confirmPassword"],
				}),
		[t],
	);

	const form = useForm<ChangePasswordValues>({
		resolver: zodResolver(schema),
		defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
	});

	const submit = form.handleSubmit(async (values) => {
		await mutation.mutateAsync(
			{ currentPassword: values.currentPassword, newPassword: values.newPassword },
			{
				onSuccess: () => {
					toast.success(t`Password changed.`);
					form.reset();
					onOpenChange(false);
				},
			},
		);
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					form.reset();
					mutation.reset();
				}
				onOpenChange(next);
			}}
		>
			<DialogContent data-testid="change-password-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Change password</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>Choose a new password for your account.</Trans>
					</DialogDescription>
				</DialogHeader>
				<form className="grid gap-3" onSubmit={(event) => void submit(event)}>
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
					{mutation.error !== null && <ErrorText error={mutation.error} />}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={mutation.isPending}>
							<Trans>Save password</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
