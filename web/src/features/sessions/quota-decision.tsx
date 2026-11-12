import type { QuotaApproval } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useId, useState } from "react";
import { DecisionFrame, DecisionTab, DecisionTabList, DecisionTabs } from "@/components/decision/decision";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TabsContent } from "@/components/ui/tabs";
import { formatNumber } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { parseGrantInput, type QuotaError, quotaStatus } from "@/lib/quota";
import { sessionTitle } from "./session-item";

/**
 * The remaining-budget line (doc/design/agent-runtime.md "Quota and token accounting"): no limit,
 * remaining, or used up. The numbers are the budget measure — output tokens —
 * never the usage statistic.
 */
function BudgetSummaryLine({
	budgetRemaining,
	budgetUsedTokens,
}: {
	budgetRemaining: number | null;
	budgetUsedTokens: number;
}) {
	const { locale } = useLocale();
	const status = quotaStatus(budgetRemaining, budgetUsedTokens);
	const usedText = formatNumber(status.used, locale);
	switch (status.kind) {
		case "unlimited":
			return <Trans>No budget limit · {usedText} spent</Trans>;
		case "remaining":
			return (
				<Trans>
					{formatNumber(status.remaining, locale)} tokens left · {usedText} spent
				</Trans>
			);
		case "exhausted":
			return (
				<span className="text-danger">
					{status.over > 0 ? (
						<Trans>
							Budget used up ({formatNumber(status.over, locale)} over) · {usedText} spent
						</Trans>
					) : (
						<Trans>Budget used up · {usedText} spent</Trans>
					)}
				</span>
			);
	}
}

/** The owner's answer to a used-up token quota. */
export type QuotaAnswer = { decision: "approve"; tokens: number } | { decision: "deny"; reason?: string };

/**
 * A root whose token quota is used up (doc/design/webui.md "Shared components"): add tokens in the
 * matching units or stop the paused run. Only the owner sees this, in the
 * session's docked decision panel.
 */
export function QuotaDecision({
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
	const { t } = useLingui();
	const id = useId();
	const [tokens, setTokens] = useState("");
	const [localError, setLocalError] = useState<string>();

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
		<DecisionFrame
			kind="quota"
			title={t`Token quota used up`}
			summary={
				<div className="grid min-w-0 gap-1 text-xs">
					<p className="min-w-0 truncate font-medium text-foreground">{sessionTitle(wait, t`New Session`)}</p>
					<p className="min-w-0 text-muted-foreground">
						<BudgetSummaryLine budgetRemaining={wait.budgetRemaining} budgetUsedTokens={wait.budgetUsedTokens} />
					</p>
				</div>
			}
			details={details}
			count={count}
			className={className}
		>
			<DecisionTabs defaultValue="add">
				<DecisionTabList label={t`How to decide`}>
					<DecisionTab value="add">
						<Trans>Add tokens</Trans>
					</DecisionTab>
					<DecisionTab value="stop">
						<Trans>Stop</Trans>
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
		</DecisionFrame>
	);
}
