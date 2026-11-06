import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorText } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { DateTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sessionTitle } from "@/features/sessions/session-item";
import type { QuotaApproval } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { parseGrantInput, type QuotaError, quotaStatus } from "@/lib/quota";
import { cn } from "@/lib/utils";

/**
 * The remaining-budget line (doc/agent-runtime.md#配额, D101): no limit, remaining, or used up. The numbers are
 * the budget measure — output tokens — never the usage statistic.
 */
export function BudgetSummaryLine({
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

export type QuotaDecision = { decision: "approve"; tokens: number } | { decision: "deny"; reason?: string };

/**
 * A root whose token quota is used up: the owner adds tokens or stops the
 * paused run. Only the owner sees these, on the approvals page and in the
 * session view.
 */
export function QuotaCard({
	wait,
	onDecide,
	busy = false,
	error,
	className,
}: {
	wait: QuotaApproval;
	onDecide: (decision: QuotaDecision) => void;
	busy?: boolean;
	error?: unknown;
	className?: string;
}) {
	const { t } = useLingui();
	const [tokens, setTokens] = useState("");
	const [localError, setLocalError] = useState<string>();

	const quotaErrorText = (error: QuotaError): string => {
		switch (error) {
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
		<section
			data-slot="quota-card"
			aria-label={t`Token budget used up`}
			className={cn("grid gap-3 rounded-lg border border-warn/30 bg-warn-bg/40 p-4 text-card-foreground", className)}
		>
			<div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
				<div className="min-w-0">
					<h2 className="truncate text-sm font-semibold">
						<Link
							to="/sessions/$sessionId"
							params={{ sessionId: wait.sessionId }}
							className="text-primary underline underline-offset-2"
						>
							{sessionTitle(wait, t`New Session`)}
						</Link>
					</h2>
					<p className="font-mono text-xs text-muted-foreground">{wait.levelId}</p>
				</div>
			</div>

			<KeyValueList
				items={[
					{
						label: <Trans>Budget</Trans>,
						value: (
							<BudgetSummaryLine budgetRemaining={wait.budgetRemaining} budgetUsedTokens={wait.budgetUsedTokens} />
						),
					},
					{ label: <Trans>Since</Trans>, value: <DateTime value={wait.since} /> },
				]}
			/>

			<div className="grid gap-1.5">
				<Label htmlFor="quota-add">{t`Tokens to add`}</Label>
				<div className="flex flex-wrap gap-2">
					<Input
						id="quota-add"
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
					<Button type="button" disabled={busy} onClick={add}>
						<Trans>Add</Trans>
					</Button>
					<Button type="button" variant="destructive" disabled={busy} onClick={() => onDecide({ decision: "deny" })}>
						<Trans>Stop</Trans>
					</Button>
				</div>
				{localError !== undefined && (
					<p role="alert" className="text-xs text-danger">
						{localError}
					</p>
				)}
			</div>

			{error !== undefined && <ErrorText error={error} />}
		</section>
	);
}
