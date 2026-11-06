import { useLingui } from "@lingui/react/macro";
import { ArrowUpIcon, DropletIcon, LightbulbIcon, ShieldCheckIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import { ModelSelect } from "@/components/model-select";
import { RulePresetSelect } from "@/components/rule-preset-select";
import { ThinkingLevelSelect } from "@/components/thinking-level-select";
import { Button } from "@/components/ui/button";
import { useModels } from "@/features/settings/api";
import type { RulePreset, SessionView } from "@/lib/api/types";
import { formatNumber, formatTokens } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { rulePresetIcon, rulePresetLabel } from "@/lib/rule-preset";
import { supportedThinkingLevels, thinkingLevelLabel } from "@/lib/thinking-level";
import { cn } from "@/lib/utils";
import { usePatchSession } from "./api";
import { QuotaDialog } from "./quota-dialog";

/**
 * The footer inside the composer box (doc/webui.md#输入框页脚): model, rules and
 * budget on the left, the stop and send buttons on the right. The context ring
 * and the tree's total usage sit on their own centered line under the box, in
 * ComposerMeta, so the footer keeps room for the model and the rule preset at every
 * width. The budget and the total usage accumulate up the chain, so a session's
 * numbers include its subagents'; the context fill is the session's own last
 * main call (doc/agent-runtime.md#会话状态).
 */
export function ComposerFooter({
	session,
	stoppable,
	sending,
	sendDisabled,
	onStop,
	stopPending,
}: {
	session: SessionView;
	/** A run (this session's or, for a root, its tree's) can be stopped. */
	stoppable: boolean;
	sending: boolean;
	sendDisabled: boolean;
	onStop: () => void;
	stopPending: boolean;
}) {
	const { t } = useLingui();
	return (
		<div className="flex min-w-0 items-center gap-2" data-testid="composer-footer">
			<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
				<span className="flex min-w-0 shrink items-center">
					<ModelControl session={session} />
				</span>
				<ThinkingControl session={session} />
				<span className="flex shrink-0 items-center">
					<RulesControl session={session} />
				</span>
				<span className="shrink-0">
					<BudgetControl session={session} />
				</span>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{stoppable && sendDisabled ? (
					<Button
						type="button"
						variant="destructive"
						size="icon-sm"
						data-testid="abort-session"
						aria-label={t`Stop`}
						title={t`Stop`}
						disabled={stopPending}
						onClick={onStop}
					>
						<SquareIcon />
					</Button>
				) : (
					<Button
						type="submit"
						size="icon-sm"
						data-testid="composer-send"
						disabled={sending || sendDisabled}
						aria-label={t`Send`}
						title={t`Send`}
					>
						<ArrowUpIcon />
					</Button>
				)}
			</div>
		</div>
	);
}

/** The model as a direct picker; a change is stored on the conversation and applies from the next turn. */
function ModelControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const models = useModels();
	const patch = usePatchSession(session.id);
	const label = `${session.model.provider}/${session.model.modelId}`;

	if (!session.capabilities.configure) {
		return (
			<span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={label}>
				{label}
			</span>
		);
	}
	return (
		<ModelSelect
			variant="inline"
			dataTestId="composer-model"
			title={t`Change the model; it applies from the next turn.`}
			models={models.data ?? []}
			value={session.model}
			disabled={patch.isPending}
			onChange={(model) => patch.mutate({ model })}
		/>
	);
}

/**
 * The thinking level right after the model; hidden when the model only supports
 * `off`, and read-only without `configure` like the model picker. A change is
 * stored on the conversation and applies from the next turn.
 */
function ThinkingControl({ session }: { session: SessionView }) {
	const { t, i18n } = useLingui();
	const models = useModels();
	const patch = usePatchSession(session.id);
	const level = session.model.thinkingLevel ?? "off";
	const levels = supportedThinkingLevels(models.data ?? [], session.model);
	if (levels.length <= 1 && levels[0] === "off") return null;
	const label = thinkingLevelLabel(i18n, level);

	if (!session.capabilities.configure) {
		return (
			<span
				className="inline-flex min-w-0 shrink items-center gap-1 px-1.5 text-xs text-muted-foreground"
				data-testid="composer-thinking"
				title={label}
			>
				<LightbulbIcon className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">{label}</span>
			</span>
		);
	}
	return (
		<span className="flex shrink-0 items-center">
			<ThinkingLevelSelect
				variant="inline"
				dataTestId="composer-thinking"
				title={t`Change the thinking level; it applies from the next turn.`}
				levels={levels}
				value={level}
				disabled={patch.isPending}
				onChange={(thinkingLevel) =>
					patch.mutate({
						model: { provider: session.model.provider, modelId: session.model.modelId, thinkingLevel },
					})
				}
			/>
		</span>
	);
}

/** The rule preset with its icon; only a root session has one, so a subagent shows its rules summary instead. */
function RulesControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const patch = usePatchSession(session.id);
	const rulePreset = session.rules?.rulePreset ?? "ask";
	const ruleCount = session.rules?.rules.length ?? 0;
	const isRoot = session.parentSessionId === null;

	if (!isRoot) {
		const label = ruleCount === 0 ? t`No rules` : t`Rules: ${ruleCount}`;
		return (
			<span
				className="inline-flex min-w-0 shrink items-center gap-1 px-1.5 text-xs text-muted-foreground"
				data-testid="composer-rules"
				title={label}
			>
				<ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">{label}</span>
			</span>
		);
	}
	const RulePresetIcon = rulePresetIcon(rulePreset) ?? ShieldCheckIcon;
	if (!session.capabilities.configure) {
		return (
			<span
				className="inline-flex min-w-0 shrink items-center gap-1 px-1.5 text-xs text-muted-foreground"
				data-testid="composer-rules"
				title={t`Rule preset: ${rulePresetLabel(rulePreset)}`}
			>
				<RulePresetIcon className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">{rulePresetLabel(rulePreset)}</span>
			</span>
		);
	}
	return (
		<RulePresetSelect
			variant="inline"
			dataTestId="composer-rules"
			title={t`Change the rule preset; it applies to the next tool call.`}
			value={rulePreset as RulePreset}
			disabled={patch.isPending}
			onChange={(next) => patch.mutate({ rulePreset: next })}
		/>
	);
}

/** The remaining budget, in auto units; clicking opens the quota dialog for a caller who may change it. */
function BudgetControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const [open, setOpen] = useState(false);
	const remaining = session.budgetRemaining;
	const exhausted = remaining !== null && remaining <= 0;
	const label = remaining === null ? "∞" : formatTokens(Math.max(0, remaining), locale);
	const title =
		remaining === null
			? t`No budget limit`
			: exhausted
				? t`The budget is used up.`
				: t`${formatNumber(remaining, locale)} tokens left`;

	if (!session.capabilities.configure) {
		return (
			<span
				data-testid="composer-budget"
				title={title}
				className={cn(
					"inline-flex shrink-0 items-center gap-1 px-1.5 text-xs whitespace-nowrap",
					exhausted ? "text-danger" : "text-muted-foreground",
				)}
			>
				<DropletIcon className="size-3.5" aria-hidden="true" />
				{label}
			</span>
		);
	}
	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="xs"
				data-testid="composer-budget"
				title={title}
				className={cn("shrink-0 gap-1 px-1.5 font-normal", exhausted && "text-danger")}
				onClick={() => setOpen(true)}
			>
				<DropletIcon className="size-3.5" aria-hidden="true" />
				<span className="whitespace-nowrap">{label}</span>
			</Button>
			<QuotaDialog session={session} open={open} onOpenChange={setOpen} />
		</>
	);
}
