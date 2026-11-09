import type { ModelRef, RulePreset, SessionView, ThinkingLevel } from "@crh/api";
import { useLingui } from "@lingui/react/macro";
import { ArrowUpIcon, DropletIcon, LightbulbIcon, ShieldCheckIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import { INLINE_CONTROL_CLASS } from "@/components/inline-control";
import { ModelSelect } from "@/components/model-select";
import { RulePresetSelect } from "@/components/rule-preset-select";
import { ThinkingLevelSelect } from "@/components/thinking-level-select";
import { Button } from "@/components/ui/button";
import { useModels } from "@/features/settings/api";
import { formatNumber, formatTokens } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { rulePresetIcon, rulePresetLabel } from "@/lib/rule-preset";
import { availableModel, supportedThinkingLevels, thinkingLevelName } from "@/lib/thinking-level";
import { cn } from "@/lib/utils";
import { usePatchSession } from "./api";
import { BudgetDialog } from "./budget-dialog";

/**
 * Everything the footer controls show and change; a session page feeds it from
 * the session and PATCHes, the draft page from local state (D117). The footer
 * itself is shared, so the two pages cannot drift apart.
 */
export interface ComposerFooterState {
	/** Undefined when no model is configured yet (the draft page disables sending). */
	model: ModelRef | undefined;
	thinkingLevel: ThinkingLevel;
	rulePreset: RulePreset;
	budgetRemaining: number | null;
	/** Whether the caller may change model, thinking level and rules. */
	configure: boolean;
	/** A root has a rule preset; a subagent shows its rule count instead. */
	isRoot: boolean;
	ruleCount: number;
	/** A change is being saved; the session footer disables its pickers meanwhile. */
	pending: boolean;
	onModelChange: (model: ModelRef) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onRulePresetChange: (rulePreset: RulePreset) => void;
	/** Resolves when a session's change is saved; the draft page resolves at once. */
	onBudgetChange: (quota: number | null) => void | Promise<void>;
}

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
	state,
	stoppable,
	sending,
	sendDisabled,
	onStop,
	stopPending,
}: {
	state: ComposerFooterState;
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
					<ModelControl state={state} />
				</span>
				<ThinkingControl state={state} />
				<span className="flex shrink-0 items-center">
					<RulesControl state={state} />
				</span>
				<span className="shrink-0">
					<BudgetControl state={state} />
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

/** The session page's footer: its model, level, rules and budget are PATCHed onto the session. */
export function SessionComposerFooter({
	session,
	stoppable,
	sending,
	sendDisabled,
	onStop,
	stopPending,
}: {
	session: SessionView;
	stoppable: boolean;
	sending: boolean;
	sendDisabled: boolean;
	onStop: () => void;
	stopPending: boolean;
}) {
	const patch = usePatchSession(session.id);
	const state: ComposerFooterState = {
		model: session.model,
		thinkingLevel: session.model.thinkingLevel ?? "off",
		rulePreset: (session.rules?.rulePreset ?? "ask") as RulePreset,
		budgetRemaining: session.budgetRemaining,
		configure: session.capabilities.configure,
		isRoot: session.parentSessionId === null,
		ruleCount: session.rules?.rules.length ?? 0,
		pending: patch.isPending,
		onModelChange: (model) => patch.mutate({ model }),
		onThinkingLevelChange: (thinkingLevel) =>
			patch.mutate({
				model: { provider: session.model.provider, modelId: session.model.modelId, thinkingLevel },
			}),
		onRulePresetChange: (rulePreset) => patch.mutate({ rulePreset }),
		onBudgetChange: async (budgetRemaining) => {
			await patch.mutateAsync({ budgetRemaining });
		},
	};
	return (
		<ComposerFooter
			state={state}
			stoppable={stoppable}
			sending={sending}
			sendDisabled={sendDisabled}
			onStop={onStop}
			stopPending={stopPending}
		/>
	);
}

/** The model as a direct picker; a change is stored on the conversation and applies from the next turn. */
function ModelControl({ state }: { state: ComposerFooterState }) {
	const { t } = useLingui();
	const models = useModels();
	const fullName = state.model === undefined ? undefined : `${state.model.provider}/${state.model.modelId}`;
	const name =
		state.model === undefined
			? undefined
			: (availableModel(models.data ?? [], state.model)?.name ?? state.model.modelId);
	const label = name ?? t`No model`;

	if (!state.configure) {
		return (
			<span className="min-w-0 truncate px-1.5 text-xs text-foreground" title={fullName ?? label}>
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
			value={state.model}
			disabled={state.pending}
			onChange={state.onModelChange}
		/>
	);
}

/**
 * The thinking level right after the model; hidden when the model only supports
 * `off`, and read-only without `configure` like the model picker. A change is
 * stored on the conversation and applies from the next turn.
 */
function ThinkingControl({ state }: { state: ComposerFooterState }) {
	const { t, i18n } = useLingui();
	const models = useModels();
	const current = availableModel(models.data ?? [], state.model);
	const levels = supportedThinkingLevels(models.data ?? [], state.model);
	if (levels.length <= 1 && levels[0] === "off") return null;
	const label = thinkingLevelName(i18n, current, state.thinkingLevel);

	if (!state.configure) {
		return (
			<span
				className="inline-flex min-w-0 shrink items-center gap-1 px-1.5 text-xs text-foreground"
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
				model={current}
				dataTestId="composer-thinking"
				title={t`Change the thinking level; it applies from the next turn.`}
				levels={levels}
				value={state.thinkingLevel}
				disabled={state.pending}
				onChange={state.onThinkingLevelChange}
			/>
		</span>
	);
}

/** The rule preset with its icon; only a root session has one, so a subagent shows its rules summary instead. */
function RulesControl({ state }: { state: ComposerFooterState }) {
	const { t } = useLingui();
	const RulePresetIcon = rulePresetIcon(state.rulePreset) ?? ShieldCheckIcon;

	if (!state.isRoot) {
		const label = state.ruleCount === 0 ? t`No rules` : t`Rules: ${state.ruleCount}`;
		return (
			<span
				className="inline-flex min-w-0 shrink items-center gap-1 px-1.5 text-xs text-foreground"
				data-testid="composer-rules"
				title={label}
			>
				<ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">{label}</span>
			</span>
		);
	}
	if (!state.configure) {
		return (
			<span
				className="inline-flex min-w-0 shrink items-center gap-1 px-1.5 text-xs text-foreground"
				data-testid="composer-rules"
				title={t`Rule preset: ${rulePresetLabel(state.rulePreset)}`}
			>
				<RulePresetIcon className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">{rulePresetLabel(state.rulePreset)}</span>
			</span>
		);
	}
	return (
		<RulePresetSelect
			variant="inline"
			dataTestId="composer-rules"
			title={t`Change the rule preset; it applies to the next tool call.`}
			value={state.rulePreset}
			disabled={state.pending}
			onChange={state.onRulePresetChange}
		/>
	);
}

/** The remaining budget, in auto units; clicking opens the quota dialog for a caller who may change it. */
function BudgetControl({ state }: { state: ComposerFooterState }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const [open, setOpen] = useState(false);
	const remaining = state.budgetRemaining;
	const exhausted = remaining !== null && remaining <= 0;
	const label = remaining === null ? "∞" : formatTokens(Math.max(0, remaining), locale);
	const title =
		remaining === null
			? t`No budget limit`
			: exhausted
				? t`The budget is used up.`
				: t`${formatNumber(remaining, locale)} tokens left`;

	if (!state.configure) {
		return (
			<span
				data-testid="composer-budget"
				title={title}
				className={cn(
					"inline-flex shrink-0 items-center gap-1 px-1.5 text-xs whitespace-nowrap",
					exhausted ? "text-danger" : "text-foreground",
				)}
			>
				<DropletIcon className="size-3.5 shrink-0" aria-hidden="true" />
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
				className={cn(INLINE_CONTROL_CLASS, "whitespace-nowrap", exhausted && "text-danger")}
				onClick={() => setOpen(true)}
			>
				<DropletIcon className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="whitespace-nowrap">{label}</span>
			</Button>
			<BudgetDialog
				open={open}
				onOpenChange={setOpen}
				value={remaining}
				busy={state.pending}
				onSave={(quota) => {
					// A local draft save resolves at once; a session PATCH closes when it succeeds.
					const saved = state.onBudgetChange(quota);
					if (saved === undefined) setOpen(false);
					else void saved.then(() => setOpen(false)).catch(() => undefined);
				}}
			/>
		</>
	);
}
