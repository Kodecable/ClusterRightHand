import type { UserKind } from "@crh/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormDialog } from "@/components/dialogs";
import { SelectField, TextField } from "@/components/form";
import { useCreateUser } from "./api";

interface NewUserValues {
	username: string;
	displayName: string;
	kind: UserKind;
	password: string;
}

/** The server's username rule, applied after trimming and lower-casing (doc/design/access-control.md "User model"). */
const USERNAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/** The "New user" dialog: name, kind and an optional initial password. */
export function NewUserDialog({ onClose }: { onClose: () => void }) {
	const { t } = useLingui();
	const create = useCreateUser();
	const schema = useMemo(
		() =>
			z.object({
				username: z
					.string()
					.trim()
					.min(1, t`A username is required.`)
					.refine(
						(value) => USERNAME_RE.test(value.toLowerCase()),
						t`Use 1–64 characters of a-z, 0-9, '.', '_' or '-', starting with a letter.`,
					),
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
			submitLabel={t`New user`}
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
