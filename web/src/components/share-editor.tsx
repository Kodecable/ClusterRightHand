import type { GranteeType } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useId, useState } from "react";
import { type EntityOption, EntityPicker } from "@/components/entity-picker";
import { FieldShell } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
 * The type/grantee/access editor of the session share dialog (doc/design/access-control.md "Ownership,
 * access grants and sharing": nodes are no longer shared, sessions are). It owns the
 * draft state; `onAdd` submits it and answers whether the share was added, so
 * the grantee is only cleared on success. The caller keeps the mutations, the
 * toasts and the list above the editor.
 */
export function ShareEditor<A extends string>({
	accessOptions,
	defaultAccess,
	layout = "stacked",
	onAdd,
	busy = false,
}: {
	accessOptions: readonly { value: A; label: ReactNode }[];
	/** Access the editor starts on, usually "view". */
	defaultAccess: A;
	layout?: "inline" | "stacked";
	/** Submits the draft; true clears the chosen grantee (the add succeeded). */
	onAdd: (draft: ShareDraft<A>) => Promise<boolean>;
	busy?: boolean;
}) {
	const { t } = useLingui();
	const prefix = useId();
	const [granteeType, setGranteeType] = useState<GranteeType>("user");
	const [granteeId, setGranteeId] = useState("");
	const [access, setAccess] = useState<A>(defaultAccess);

	// The directory picker holds both kinds; the selected option says which one the share names.
	const chooseGrantee = (id: string | null, option: EntityOption | null) => {
		setGranteeId(id ?? "");
		if (option !== null) setGranteeType(option.kind === "userGroup" ? "user_group" : "user");
	};

	const add = async () => {
		if (granteeId === "") return;
		if (await onAdd({ granteeType, granteeId, access })) setGranteeId("");
	};

	const granteeSelect = (
		<EntityPicker
			kind="directory"
			label={t`Grantee`}
			value={granteeId === "" ? null : granteeId}
			onChange={chooseGrantee}
			className={layout === "inline" ? "w-56" : "w-full"}
		/>
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
			<ShareField layout="stacked" id={`${prefix}-grantee`} label={t`Grantee`}>
				{granteeSelect}
			</ShareField>
			<ShareField layout="stacked" id={`${prefix}-access`} label={t`Access`}>
				{accessSelect}
			</ShareField>
			<Button type="button" size="sm" disabled={granteeId === "" || busy} onClick={() => void add()}>
				<Trans>Add share</Trans>
			</Button>
		</div>
	);
}
