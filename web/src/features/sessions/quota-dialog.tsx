import type { SessionView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/dialogs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseQuotaInput, type QuotaError } from "@/lib/quota";
import { usePatchSession } from "./api";

/**
 * The budget field, shared by the session footer (patches the session) and the draft page (local state):
 * empty means unlimited, a number is the remaining budget (D101). The caller closes the dialog when its
 * save succeeds.
 */
export function BudgetDialog({
	open,
	onOpenChange,
	value,
	busy = false,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	value: number | null;
	busy?: boolean;
	onSave: (quota: number | null) => void;
}) {
	const { t } = useLingui();
	const [text, setText] = useState(value === null ? "" : String(value));
	const [error, setError] = useState<QuotaError>();

	useEffect(() => {
		if (open) {
			setText(value === null ? "" : String(value));
			setError(undefined);
		}
	}, [open, value]);

	const errorText = (code: QuotaError): string => {
		switch (code) {
			case "whole-number":
				return t`Enter a whole number of tokens, or leave it empty for unlimited.`;
			case "too-large":
				return t`That number is too large.`;
			case "positive-required":
				return t`Enter a positive number of tokens to add.`;
		}
	};

	const save = () => {
		const parsed = parseQuotaInput(text);
		if ("error" in parsed) {
			setError(parsed.error);
			return;
		}
		setError(undefined);
		onSave(parsed.quota);
	};

	return (
		<FormDialog
			open={open}
			onOpenChange={onOpenChange}
			title={<Trans>Token budget</Trans>}
			submitLabel={<Trans>Save</Trans>}
			busy={busy}
			error={error !== undefined ? errorText(error) : undefined}
			className="sm:max-w-sm"
			onSubmit={save}
		>
			<Label htmlFor="session-quota">
				<Trans>Remaining budget tokens (empty = unlimited)</Trans>
			</Label>
			<Input
				id="session-quota"
				inputMode="numeric"
				value={text}
				placeholder={t`Unlimited`}
				onChange={(event) => setText(event.target.value)}
			/>
		</FormDialog>
	);
}

/** The owner's budget dialog for an existing session. */
export function QuotaDialog({
	session,
	open,
	onOpenChange,
}: {
	session: SessionView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useLingui();
	const patch = usePatchSession(session.id);
	return (
		<BudgetDialog
			open={open}
			onOpenChange={onOpenChange}
			value={session.budgetRemaining}
			busy={patch.isPending}
			onSave={(budgetRemaining) => {
				patch.mutate(
					{ budgetRemaining },
					{
						onSuccess: () => {
							toast.success(t`Quota saved.`);
							onOpenChange(false);
						},
					},
				);
			}}
		/>
	);
}
