import { useLingui } from "@lingui/react/macro";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Preset } from "@/lib/api/types";

const PRESETS: { value: Preset; label: () => string }[] = [
	{ value: "ask", label: () => "Ask" },
	{ value: "auto_review", label: () => "Auto Review" },
	{ value: "yolo", label: () => "Yolo" },
];

export interface PresetSelectProps {
	value: Preset;
	onChange: (preset: Preset) => void;
	disabled?: boolean;
	id?: string;
	label?: string;
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
			<SelectTrigger id={id} aria-label={label ?? t`Preset`} className={`w-full ${className ?? ""}`.trim()}>
				<SelectValue>
					{(current: string | null) => PRESETS.find((preset) => preset.value === current)?.label() ?? ""}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{PRESETS.map((preset) => (
					<SelectItem key={preset.value} value={preset.value}>
						{preset.label()}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
