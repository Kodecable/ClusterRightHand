import { Trans, useLingui } from "@lingui/react/macro";
import { ActivityIcon, GaugeIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ModelSelect } from "@/components/model-select";
import { PresetSelect } from "@/components/preset-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useModels } from "@/features/settings/api";
import type { Preset, SessionView } from "@/lib/api/types";
import { formatNumber, formatTokens } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { presetIcon, presetLabel } from "@/lib/preset";
import { cn } from "@/lib/utils";
import { usePatchSession } from "./api";
import { QuotaDialog } from "./quota-dialog";

/**
 * The row under the composer input (doc/webui.md#输入框页脚): model, rules, budget, context and total usage on
 * the left, the stop and send buttons on the right. A ResizeObserver measures the row: the optional counters keep
 * their natural width, and only while the row does not fit are they hidden, usage first, then the context ring,
 * then the budget. Model and rules truncate only once all three are hidden, and the two buttons never shrink.
 * The budget and the total usage accumulate up the chain, so a session's numbers include its subagents'; the
 * context fill is the session's own last main call (doc/agent-runtime.md#会话状态).
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
	const rootRef = useRef<HTMLDivElement | null>(null);
	const leftRef = useRef<HTMLDivElement | null>(null);
	const buttonsRef = useRef<HTMLDivElement | null>(null);
	const modelRef = useRef<HTMLSpanElement | null>(null);
	const rulesRef = useRef<HTMLSpanElement | null>(null);
	const budgetRef = useRef<HTMLSpanElement | null>(null);
	const contextRef = useRef<HTMLSpanElement | null>(null);
	const usageRef = useRef<HTMLSpanElement | null>(null);
	// How many of usage, context and budget are hidden, in that order: 0 shows all three, 3 shows none.
	const [hiddenCount, setHiddenCount] = useState(0);

	const measure = useCallback(() => {
		const root = rootRef.current;
		const left = leftRef.current;
		const buttons = buttonsRef.current;
		if (root === null || left === null || buttons === null) return;
		const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 0;
		const itemGap = Number.parseFloat(getComputedStyle(left).columnGap) || 0;
		const model = naturalWidth(modelRef.current);
		const rules = naturalWidth(rulesRef.current);
		// Budget, context and usage in DOM order: the visible ones are a prefix of this list.
		const optional = [budgetRef.current, contextRef.current, usageRef.current].map(naturalWidth);
		const available = root.clientWidth - buttons.offsetWidth - gap;
		const widthOf = (visible: number) =>
			model + rules + optional.slice(0, visible).reduce((sum, width) => sum + width, 0) + itemGap * (visible + 1);
		// One pixel of slack either way: an item hides only when the row overflows and shows only when it fits
		// with room to spare, so a subpixel measurement cannot make it alternate between shown and hidden.
		const slack = 1;
		setHiddenCount((current) => {
			const shown = optional.length - current;
			if (widthOf(shown) > available + slack) {
				let visible = shown;
				while (visible > 0 && widthOf(visible) > available + slack) visible -= 1;
				return optional.length - visible;
			}
			if (shown < optional.length && widthOf(shown + 1) <= available - slack) {
				let visible = shown + 1;
				while (visible < optional.length && widthOf(visible + 1) <= available - slack) visible += 1;
				return optional.length - visible;
			}
			return current;
		});
	}, []);

	// Measure after every render (a new label, locale or font changes a width) and whenever the row resizes.
	useLayoutEffect(() => {
		measure();
	});
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (root === null) return;
		const observer = new ResizeObserver(measure);
		for (const element of [
			root,
			leftRef.current,
			buttonsRef.current,
			modelRef.current,
			rulesRef.current,
			budgetRef.current,
			contextRef.current,
			usageRef.current,
		]) {
			if (element !== null) observer.observe(element);
		}
		return () => observer.disconnect();
	}, [measure]);

	return (
		<div ref={rootRef} className="flex min-w-0 items-center gap-2" data-testid="composer-footer">
			<div ref={leftRef} className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
				<span ref={modelRef} className={cn("flex min-w-0 items-center", hiddenCount === 3 ? "shrink" : "shrink-0")}>
					<ModelControl session={session} />
				</span>
				<span ref={rulesRef} className={cn("flex min-w-0 items-center", hiddenCount === 3 ? "shrink" : "shrink-0")}>
					<RulesControl session={session} />
				</span>
				<span ref={budgetRef} className={optionalClass(hiddenCount >= 3)}>
					<BudgetControl session={session} />
				</span>
				<span ref={contextRef} className={optionalClass(hiddenCount >= 2)}>
					<ContextControl session={session} />
				</span>
				<span ref={usageRef} className={optionalClass(hiddenCount >= 1)}>
					<UsageControl session={session} />
				</span>
			</div>
			<div ref={buttonsRef} className="flex shrink-0 items-center gap-1.5">
				{stoppable && (
					<Button
						type="button"
						variant="destructive"
						size="sm"
						data-testid="abort-session"
						disabled={stopPending}
						onClick={onStop}
					>
						<Trans>Stop</Trans>
					</Button>
				)}
				<Button
					type="submit"
					size="sm"
					data-testid="composer-send"
					disabled={sending || sendDisabled}
					aria-label={t`Send`}
				>
					<Trans>Send</Trans>
				</Button>
			</div>
		</div>
	);
}

/**
 * A counter's wrapper: in the row when it fits, laid out but invisible when hidden, so its natural width stays
 * measurable without a second copy of the control. An invisible absolute element cannot be clicked or focused.
 */
function optionalClass(hidden: boolean): string {
	return cn(
		"inline-flex items-center",
		// A child's `transition-all` would otherwise keep `visibility` visible for one transition; disabling it
		// makes the hide take effect in the same style change that measured the row.
		hidden ? "pointer-events-none invisible absolute start-0 top-0 [&_*]:transition-none" : "shrink-0",
	);
}

/**
 * The width an item needs before any truncation. A hidden optional item is out of the flow but still laid out at
 * its natural width; a truncating label keeps the full text in `scrollWidth`, so its box plus the clipped part is
 * the natural width of the whole control.
 */
function naturalWidth(element: HTMLElement | null): number {
	if (element === null) return 0;
	const label = element.matches("[data-footer-label]")
		? element
		: element.querySelector<HTMLElement>("[data-footer-label]");
	if (label === null) return element.offsetWidth;
	return element.offsetWidth - label.offsetWidth + label.scrollWidth;
}

/** The model as clickable text; a change is stored on the conversation and applies from the next turn. */
function ModelControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const models = useModels();
	const patch = usePatchSession(session.id);
	const [open, setOpen] = useState(false);
	const label = `${session.model.provider}/${session.model.modelId}`;

	if (!session.capabilities.configure) {
		return (
			<span data-footer-label className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={label}>
				{label}
			</span>
		);
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="xs"
						data-testid="composer-model"
						className="min-w-0 shrink gap-1 font-mono font-normal"
						title={t`Change the model; it applies from the next turn.`}
					/>
				}
			>
				<span data-footer-label className="min-w-0 truncate">
					{label}
				</span>
			</PopoverTrigger>
			<PopoverContent align="start" side="top" className="w-72">
				<Label htmlFor="composer-model-select">
					<Trans>Model</Trans>
				</Label>
				<ModelSelect
					id="composer-model-select"
					models={models.data ?? []}
					value={session.model}
					disabled={patch.isPending}
					onChange={(model) => patch.mutate({ model }, { onSuccess: () => setOpen(false) })}
				/>
				<p className="text-xs text-muted-foreground">
					<Trans>A new model applies from the next turn.</Trans>
				</p>
			</PopoverContent>
		</Popover>
	);
}

/** The preset with its icon; only a root session has one, so a subagent shows its rules summary instead. */
function RulesControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const patch = usePatchSession(session.id);
	const [open, setOpen] = useState(false);
	const preset = session.rules?.preset ?? "ask";
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
				<ShieldCheckIcon className="size-3 shrink-0" aria-hidden="true" />
				<span data-footer-label className="min-w-0 truncate">
					{label}
				</span>
			</span>
		);
	}
	const PresetIcon = presetIcon(preset) ?? ShieldCheckIcon;
	if (!session.capabilities.configure) {
		return (
			<span
				className="inline-flex min-w-0 shrink items-center gap-1 px-1.5 text-xs text-muted-foreground"
				data-testid="composer-rules"
				title={t`Preset: ${presetLabel(preset)}`}
			>
				<PresetIcon className="size-3 shrink-0" aria-hidden="true" />
				<span data-footer-label className="min-w-0 truncate">
					{presetLabel(preset)}
				</span>
			</span>
		);
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="xs"
						data-testid="composer-rules"
						className="min-w-0 shrink gap-1 font-normal"
						title={t`Change the preset; it applies to the next tool call.`}
					/>
				}
			>
				<PresetIcon className="size-3 shrink-0" aria-hidden="true" />
				<span data-footer-label className="min-w-0 truncate">
					{presetLabel(preset)}
				</span>
			</PopoverTrigger>
			<PopoverContent align="start" side="top" className="w-72">
				<Label htmlFor="composer-preset-select">
					<Trans>Preset</Trans>
				</Label>
				<PresetSelect
					id="composer-preset-select"
					value={preset as Preset}
					disabled={patch.isPending}
					onChange={(next) => patch.mutate({ preset: next }, { onSuccess: () => setOpen(false) })}
				/>
				<p className="text-xs text-muted-foreground">
					<Trans>A new preset applies to the next tool call; waiting approvals are decided again.</Trans>
				</p>
			</PopoverContent>
		</Popover>
	);
}

/** The remaining budget, in auto units; clicking opens the quota dialog for a caller who may change it. */
function BudgetControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const [open, setOpen] = useState(false);
	const remaining = session.budgetRemaining;
	const exhausted = remaining !== null && remaining <= 0;
	const label =
		remaining === null ? t`No budget limit` : exhausted ? t`Budget 0` : t`Budget ${formatTokens(remaining, locale)}`;
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
				<GaugeIcon className="size-3" aria-hidden="true" />
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
				<GaugeIcon className="size-3" aria-hidden="true" />
				<span className="whitespace-nowrap">{label}</span>
			</Button>
			<QuotaDialog session={session} open={open} onOpenChange={setOpen} />
		</>
	);
}

/** The context fill of the last main call as a ring and a percentage; hidden until both are known. */
function ContextControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const models = useModels();
	const used = session.contextTokens;
	const model = models.data?.find(
		(candidate) => candidate.provider === session.model.provider && candidate.modelId === session.model.modelId,
	);
	if (used === null || model === undefined || model.contextWindow <= 0) return null;
	const ratio = used / model.contextWindow;
	const percent = Math.max(0, Math.round(ratio * 100));
	const title = `${formatNumber(used, locale)} / ${formatNumber(model.contextWindow, locale)}`;
	return (
		<span
			data-testid="composer-context"
			title={title}
			role="img"
			aria-label={t`Context: ${percent}% used`}
			className={cn(
				"inline-flex shrink-0 items-center gap-1 px-1.5 text-xs whitespace-nowrap text-muted-foreground",
				ratio >= 0.9 && "text-warn",
			)}
		>
			<ContextRing ratio={ratio} />
			{percent}%
		</span>
	);
}

/** A small ring that fills with the context; the percentage sits beside it. */
function ContextRing({ ratio }: { ratio: number }) {
	const radius = 5;
	const circumference = 2 * Math.PI * radius;
	const filled = circumference * Math.min(1, Math.max(0, ratio));
	return (
		<svg viewBox="0 0 14 14" aria-hidden="true" className="size-3.5 shrink-0 -rotate-90">
			<circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
			<circle
				cx="7"
				cy="7"
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeDasharray={`${filled} ${circumference - filled}`}
			/>
		</svg>
	);
}

/** The total usage of the session tree, in auto units; the exact number is the tooltip. */
function UsageControl({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const exact = formatNumber(session.usageTokens, locale);
	return (
		<span
			data-testid="composer-usage"
			title={t`${exact} tokens in total`}
			className="inline-flex shrink-0 items-center gap-1 px-1.5 text-xs whitespace-nowrap text-muted-foreground"
		>
			<ActivityIcon className="size-3" aria-hidden="true" />
			{formatTokens(session.usageTokens, locale)}
		</span>
	);
}
