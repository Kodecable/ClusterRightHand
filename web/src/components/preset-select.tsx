import { useLingui } from "@lingui/react/macro";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Preset } from "@/lib/api/types";
import { PRESETS, presetLabel } from "@/lib/preset";

export interface PresetSelectProps {
	value: Preset;
	onChange: (preset: Preset) => void;
	disabled?: boolean;
	id?: string;
	label?: string;
	/** Trigger width: full width by default, a fixed width where the picker sits beside a button. */
	className?: string;
}

/**
 * The rule preset picker. The labels are product names ("Ask", "Yolo"); the
 * explanation of each preset belongs next to the form (scheduleForm's
 * `presetNote`), not in the option text.
 */
export function PresetSelect({ value, onChange, disabled, id, label, className }: PresetSelectProps) {
	const { t } = useLingui();
	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (typeof next === "string") onChange(next as Preset);
			}}
			disabled={disabled}
		>
			<SelectTrigger id={id} aria-label={label ?? t`Preset`} className={className ?? "w-full"}>
				<SelectValue>{(current: string | null) => presetLabel(current)}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{PRESETS.map((preset) => (
					<SelectItem key={preset.value} value={preset.value}>
						{preset.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
