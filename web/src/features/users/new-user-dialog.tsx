import { zodResolver } from "@hookform/resolvers/zod";
import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormDialog } from "@/components/dialogs";
import { SelectField, TextField } from "@/components/form";
import type { UserKind } from "@/lib/api/types";
import { useCreateUser } from "./api";

interface NewUserValues {
	username: string;
	displayName: string;
	kind: UserKind;
	password: string;
}

/** The "New user" dialog: name, kind and an optional initial password. */
export function NewUserDialog({ onClose }: { onClose: () => void }) {
	const { t } = useLingui();
	const create = useCreateUser();
	const schema = useMemo(
		() =>
			z.object({
				username: z.string().trim().min(1, t`A username is required.`),
				displayName: z.string().max(100, t`The display name must be at most 100 characters.`),
				kind: z.enum(["admin", "member"]),
				password: z
					.string()
					.refine((value) => value === "" || value.length >= 8, t`Use at least 8 characters, or leave it empty.`),
			}),
		[t],
	);
	const form = useForm<NewUserValues>({
		resolver: zodResolver(schema),
		defaultValues: { username: "", displayName: "", kind: "member", password: "" },
	});
	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`New user`}
			description={t`A user without a password cannot sign in until an administrator sets one.`}
			busy={create.isPending}
			submitLabel={t`Create user`}
			onSubmit={() =>
				void form.handleSubmit((values) => {
					create.mutate(
						{
							username: values.username.trim(),
							displayName: values.displayName.trim() || undefined,
							kind: values.kind,
							password: values.password === "" ? undefined : values.password,
						},
						{
							onSuccess: () => {
								toast.success(t`User created.`);
								onClose();
							},
						},
					);
				})()
			}
		>
			<TextField control={form.control} name="username" label={t`Username`} autoComplete="off" />
			<TextField control={form.control} name="displayName" label={t`Display name`} />
			<SelectField
				control={form.control}
				name="kind"
				label={t`Kind`}
				options={[
					{ value: "member", label: t`Member` },
					{ value: "admin", label: t`Administrator` },
				]}
			/>
			<TextField
				control={form.control}
				name="password"
				type="password"
				label={t`Password`}
				autoComplete="new-password"
				description={t`Optional; at least 8 characters.`}
			/>
		</FormDialog>
	);
}
