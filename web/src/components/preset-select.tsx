import { useLingui } from "@lingui/react/macro";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Preset } from "@/lib/api/types";
import { PRESETS, presetIcon, presetLabel } from "@/lib/preset";
import { cn } from "@/lib/utils";

export interface PresetSelectProps {
	value: Preset;
	onChange: (preset: Preset) => void;
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
 * explanation of each preset belongs next to the form (scheduleForm's
 * `presetNote`), not in the option text.
 */
export function PresetSelect({
	value,
	onChange,
	disabled,
	id,
	label,
	className,
	variant = "default",
	title,
	dataTestId,
}: PresetSelectProps) {
	const { t } = useLingui();
	const inline = variant === "inline";
	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (typeof next === "string") onChange(next as Preset);
			}}
			disabled={disabled}
		>
			<SelectTrigger
				id={id}
				aria-label={label ?? t`Preset`}
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
						const Icon = presetIcon(current);
						return (
							<span className="flex items-center gap-1.5">
								{Icon !== undefined && <Icon className="size-3.5" aria-hidden="true" />}
								{presetLabel(current)}
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
				{PRESETS.map((preset) => {
					const Icon = preset.icon;
					return (
						<SelectItem key={preset.value} value={preset.value}>
							<Icon className="size-3.5" aria-hidden="true" />
							{preset.label}
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	);
}
