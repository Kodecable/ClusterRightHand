import type { GranteeType } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useId, useMemo, useState } from "react";
import { FieldShell } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDirectory } from "@/features/users/api";

export interface ShareDraft<A extends string> {
	granteeType: GranteeType;
	granteeId: string;
	access: A;
}

/** One labelled control: the node page's inline form uses FieldShell, the session dialog plain labels. */
function ShareField({
	layout,
	id,
	label,
	className,
	children,
}: {
	layout: "inline" | "stacked";
	id: string;
	label: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	if (layout === "inline") {
		return (
			<FieldShell id={id} label={label} className={className}>
				{children}
			</FieldShell>
		);
	}
	return (
		<div className="grid gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children}
		</div>
	);
}

/**
 * The type/grantee/access editor of the session share dialog (doc/access-control.md
 * "归属访问授权与分享": nodes are no longer shared, sessions are). It owns the
 * draft state; `onAdd` submits it and answers whether the share was added, so
 * the grantee is only cleared on success. The caller keeps the mutations, the
 * toasts and the list above the editor.
 */
export function ShareEditor<A extends string>({
	accessOptions,
	defaultAccess,
	userGroupLabel,
	layout = "stacked",
	onAdd,
	busy = false,
}: {
	accessOptions: readonly { value: A; label: ReactNode }[];
	/** Access the editor starts on, usually "view". */
	defaultAccess: A;
	/** How this page names a user group: "User group" on both a node and a session. */
	userGroupLabel: ReactNode;
	layout?: "inline" | "stacked";
	/** Submits the draft; true clears the chosen grantee (the add succeeded). */
	onAdd: (draft: ShareDraft<A>) => Promise<boolean>;
	busy?: boolean;
}) {
	const { t } = useLingui();
	const prefix = useId();
	const directory = useDirectory();
	const [granteeType, setGranteeType] = useState<GranteeType>("user");
	const [granteeId, setGranteeId] = useState("");
	const [access, setAccess] = useState<A>(defaultAccess);

	const grantees = useMemo(
		() =>
			granteeType === "user"
				? (directory.data?.users ?? []).map((user) => ({ id: user.id, label: user.displayName || user.username }))
				: (directory.data?.userGroups ?? []).map((group) => ({ id: group.id, label: group.name })),
		[directory.data, granteeType],
	);

	const add = async () => {
		if (granteeId === "") return;
		if (await onAdd({ granteeType, granteeId, access })) setGranteeId("");
	};

	const typeSelect = (
		<Select
			value={granteeType}
			onValueChange={(next) => {
				if (next !== "user" && next !== "user_group") return;
				setGranteeType(next);
				setGranteeId("");
			}}
		>
			<SelectTrigger id={`${prefix}-type`} className={layout === "inline" ? "w-36" : "w-full"}>
				<SelectValue>
					{(current: string | null) => (current === "user_group" ? userGroupLabel : <Trans>User</Trans>)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="user">
					<Trans>User</Trans>
				</SelectItem>
				<SelectItem value="user_group">{userGroupLabel}</SelectItem>
			</SelectContent>
		</Select>
	);

	const granteeSelect = (
		<Select value={granteeId === "" ? null : granteeId} onValueChange={(next) => setGranteeId(String(next ?? ""))}>
			<SelectTrigger id={`${prefix}-grantee`} className={layout === "inline" ? "w-56" : "w-full"}>
				<SelectValue placeholder={t`Select…`}>
					{(current: string | null) => grantees.find((option) => option.id === current)?.label ?? t`Select…`}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{grantees.map((option) => (
					<SelectItem key={option.id} value={option.id}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);

	const accessSelect = (
		<Select
			value={access}
			onValueChange={(next) => {
				if (typeof next !== "string" || !accessOptions.some((option) => option.value === next)) return;
				setAccess(next as A);
			}}
		>
			<SelectTrigger id={`${prefix}-access`} className={layout === "inline" ? "w-32" : "w-full"}>
				<SelectValue>
					{(current: string | null) => accessOptions.find((option) => option.value === current)?.label ?? ""}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{accessOptions.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);

	if (layout === "inline") {
		return (
			<form
				className="flex flex-wrap items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void add();
				}}
			>
				<ShareField layout="inline" id={`${prefix}-type`} label={t`Type`}>
					{typeSelect}
				</ShareField>
				<ShareField layout="inline" id={`${prefix}-grantee`} label={t`Grantee`} className="min-w-48">
					{granteeSelect}
				</ShareField>
				<ShareField layout="inline" id={`${prefix}-access`} label={t`Access`}>
					{accessSelect}
				</ShareField>
				<Button type="submit" disabled={busy || granteeId === ""}>
					<Trans>Add share</Trans>
				</Button>
			</form>
		);
	}

	return (
		<div className="grid gap-2 rounded-md border p-3">
			<div className="grid grid-cols-2 gap-2">
				<ShareField layout="stacked" id={`${prefix}-type`} label={t`Type`}>
					{typeSelect}
				</ShareField>
				<ShareField layout="stacked" id={`${prefix}-access`} label={t`Access`}>
					{accessSelect}
				</ShareField>
			</div>
			<ShareField layout="stacked" id={`${prefix}-grantee`} label={t`Grantee`}>
				{granteeSelect}
			</ShareField>
			<Button type="button" size="sm" disabled={granteeId === "" || busy} onClick={() => void add()}>
				<Trans>Add share</Trans>
			</Button>
		</div>
	);
}
