import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/dialogs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SessionView } from "@/lib/api/types";
import { parseQuotaInput, type QuotaError } from "@/lib/quota";
import { usePatchSession } from "./api";

/** The owner's token-quota dialog: empty means unlimited, a number is the remaining budget. */
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
	const [text, setText] = useState(session.quota === null ? "" : String(session.quota));
	const [error, setError] = useState<QuotaError>();

	useEffect(() => {
		if (open) setText(session.quota === null ? "" : String(session.quota));
	}, [open, session.quota]);

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
		patch.mutate(
			{ quota: parsed.quota },
			{
				onSuccess: () => {
					toast.success(t`Quota saved.`);
					onOpenChange(false);
				},
			},
		);
	};

	return (
		<FormDialog
			open={open}
			onOpenChange={onOpenChange}
			title={<Trans>Token quota</Trans>}
			submitLabel={<Trans>Save</Trans>}
			busy={patch.isPending}
			error={error !== undefined ? errorText(error) : undefined}
			className="sm:max-w-sm"
			onSubmit={save}
		>
			<Label htmlFor="session-quota">
				<Trans>Remaining tokens (empty = unlimited)</Trans>
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
