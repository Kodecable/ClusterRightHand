import type { QuotaApproval } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useId, useState } from "react";
import { quotaCardContent } from "@/components/decision/content";
import { DecisionCard, DecisionTab, DecisionTabList, DecisionTabs } from "@/components/decision/decision";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TabsContent } from "@/components/ui/tabs";
import { parseGrantInput, type QuotaError } from "@/lib/quota";

/** The owner's answer to a used-up token quota. */
export type QuotaAnswer = { decision: "approve"; tokens: number } | { decision: "deny"; reason?: string };

/**
 * A root whose token quota is used up (doc/design/webui.md "Shared components"): the same decision card as
 * every other wait, with the session's title as meta and the budget as its detail, then Add tokens and
 * Stop. Only the owner sees this, in the session's docked decision panel.
 */
export function QuotaPanel({
	wait,
	onDecide,
	busy = false,
	error,
	details,
	count,
	className,
}: {
	wait: QuotaApproval;
	onDecide: (decision: QuotaAnswer) => void;
	busy?: boolean;
	error?: unknown;
	details?: ReactNode;
	count?: ReactNode;
	className?: string;
}) {
	const { t, i18n } = useLingui();
	const id = useId();
	const [tokens, setTokens] = useState("");
	const [localError, setLocalError] = useState<string>();
	const content = quotaCardContent(wait, i18n);

	const quotaErrorText = (quotaError: QuotaError): string => {
		switch (quotaError) {
			case "whole-number":
				return t`Enter a whole number of tokens, or leave it empty for unlimited.`;
			case "too-large":
				return t`That number is too large.`;
			case "positive-required":
				return t`Enter a positive number of tokens to add.`;
		}
	};

	const add = () => {
		const parsed = parseGrantInput(tokens);
		if ("error" in parsed) {
			setLocalError(quotaErrorText(parsed.error));
			return;
		}
		setLocalError(undefined);
		setTokens("");
		onDecide({ decision: "approve", tokens: parsed.tokens });
	};

	return (
		<DecisionCard {...content} kind="quota" count={count} details={details} className={className}>
			<DecisionTabs defaultValue="add">
				{/* Stop, the refusal, is always the first tab; the panel opens on the one after it. */}
				<DecisionTabList label={t`How to decide`}>
					<DecisionTab value="stop">
						<Trans>Stop</Trans>
					</DecisionTab>
					<DecisionTab value="add">
						<Trans>Add tokens</Trans>
					</DecisionTab>
				</DecisionTabList>
				<TabsContent value="add" className="grid min-w-0 gap-2 pt-1">
					<Label htmlFor={id}>{t`Tokens to add`}</Label>
					<div className="flex flex-wrap items-center gap-2">
						<Input
							id={id}
							inputMode="numeric"
							value={tokens}
							placeholder="1000000"
							disabled={busy}
							className="max-w-48"
							onChange={(event) => setTokens(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									add();
								}
							}}
						/>
						<Button type="button" className="ml-auto" disabled={busy} onClick={add}>
							<Trans>Add</Trans>
						</Button>
					</div>
					{localError !== undefined && (
						<p role="alert" className="text-xs text-danger">
							{localError}
						</p>
					)}
				</TabsContent>
				<TabsContent value="stop" className="grid min-w-0 gap-2 pt-1">
					<p className="text-xs text-muted-foreground">
						<Trans>Stop the paused run instead of adding tokens.</Trans>
					</p>
					<div className="flex justify-end">
						<Button type="button" variant="destructive" disabled={busy} onClick={() => onDecide({ decision: "deny" })}>
							<Trans>Stop</Trans>
						</Button>
					</div>
				</TabsContent>
			</DecisionTabs>
			{error !== undefined && <ErrorText error={error} />}
		</DecisionCard>
	);
}
