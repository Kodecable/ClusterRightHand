import type { AvailableModel, ThinkingLevel } from "@crh/api";
import { useLingui } from "@lingui/react/macro";
import { LightbulbIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { thinkingLevelName } from "@/lib/thinking-level";
import { cn } from "@/lib/utils";

export interface ThinkingLevelSelectProps {
	/** The current model, for its custom display names; built-in models use localized names. */
	model?: AvailableModel;
	/** Only the current model's supported levels, `off` included. */
	levels: ThinkingLevel[];
	value: ThinkingLevel;
	onChange: (level: ThinkingLevel) => void;
	label?: string;
	disabled?: boolean;
	id?: string;
	title?: string;
	dataTestId?: string;
	/** `inline` drops the form-field chrome for a composer footer trigger. */
	variant?: "default" | "inline";
}

/**
 * The thinking level picker shown next to a model (doc/webui.md#输入框页脚): only
 * the levels the current model supports, with the caller hiding it when that is
 * only `off`.
 */
export function ThinkingLevelSelect({
	model,
	levels,
	value,
	onChange,
	label,
	disabled,
	id,
	title,
	dataTestId,
	variant = "default",
}: ThinkingLevelSelectProps) {
	const { t, i18n } = useLingui();
	const inline = variant === "inline";
	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (typeof next === "string") onChange(next as ThinkingLevel);
			}}
			disabled={disabled}
		>
			<SelectTrigger
				id={id}
				aria-label={label ?? t`Thinking level`}
				title={title}
				size={inline ? "xs" : "default"}
				showIcon={!inline}
				data-testid={dataTestId}
				className={cn(
					"w-full",
					inline &&
						"w-fit min-w-0 shrink justify-start gap-1 border-0 bg-transparent px-1.5 font-normal shadow-none hover:bg-muted aria-expanded:bg-muted",
				)}
			>
				<SelectValue>
					{(current: string | null) => {
						const level = (current as ThinkingLevel | null) ?? "off";
						const text = thinkingLevelName(i18n, model, level);
						return inline ? (
							<span className="inline-flex min-w-0 items-center gap-1">
								<LightbulbIcon className="size-3.5 shrink-0" aria-hidden="true" />
								<span className="min-w-0 truncate">{text}</span>
							</span>
						) : (
							text
						);
					}}
				</SelectValue>
			</SelectTrigger>
			<SelectContent side={inline ? "top" : undefined} align={inline ? "start" : undefined}>
				{levels.map((level) => (
					<SelectItem key={level} value={level}>
						{thinkingLevelName(i18n, model, level)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
