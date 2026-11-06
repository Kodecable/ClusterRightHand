import { useLingui } from "@lingui/react/macro";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { RulePreset } from "@/lib/api/types";
import { RULE_PRESETS, rulePresetIcon, rulePresetLabel } from "@/lib/rule-preset";
import { cn } from "@/lib/utils";

export interface RulePresetSelectProps {
	value: RulePreset;
	onChange: (rulePreset: RulePreset) => void;
	disabled?: boolean;
	id?: string;
	label?: string;
	/** Trigger width: full width by default, a fixed width where the picker sits beside a button. */
	className?: string;
	/** `inline` drops the form-field chrome for a composer footer trigger. */
	variant?: "default" | "inline";
	title?: string;
	dataTestId?: string;
}

/**
 * The rule preset picker. The labels are product names ("Ask", "Yolo"); the
 * explanation of each rule preset belongs next to the form (scheduleForm's
 * `rulePresetNote`), not in the option text.
 */
export function RulePresetSelect({
	value,
	onChange,
	disabled,
	id,
	label,
	className,
	variant = "default",
	title,
	dataTestId,
}: RulePresetSelectProps) {
	const { t } = useLingui();
	const inline = variant === "inline";
	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (typeof next === "string") onChange(next as RulePreset);
			}}
			disabled={disabled}
		>
			<SelectTrigger
				id={id}
				aria-label={label ?? t`Rule preset`}
				title={title}
				size={inline ? "xs" : "default"}
				showIcon={!inline}
				data-testid={dataTestId}
				className={cn(
					"w-full",
					inline &&
						"w-fit shrink justify-start gap-1 border-0 bg-transparent px-2 text-xs font-normal shadow-none hover:bg-muted aria-expanded:bg-muted [&>svg]:hidden",
					className,
				)}
			>
				<SelectValue>
					{(current: string | null) => {
						const Icon = rulePresetIcon(current);
						return (
							<span className="flex items-center gap-1.5">
								{Icon !== undefined && <Icon className="size-3.5" aria-hidden="true" />}
								{rulePresetLabel(current)}
							</span>
						);
					}}
				</SelectValue>
			</SelectTrigger>
			<SelectContent
				side={inline ? "top" : undefined}
				align={inline ? "start" : undefined}
				alignItemWithTrigger={inline ? false : undefined}
				className={inline ? "w-56" : undefined}
			>
				{RULE_PRESETS.map((rulePreset) => {
					const Icon = rulePreset.icon;
					return (
						<SelectItem key={rulePreset.value} value={rulePreset.value}>
							<Icon className="size-3.5" aria-hidden="true" />
							{rulePreset.label}
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	);
}
