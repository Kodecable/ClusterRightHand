import { useLingui } from "@lingui/react/macro";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { AvailableModel, ModelRef } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const SEPARATOR = "\u0000";

/** The select value of a model reference. */
export function modelKey(model: ModelRef): string {
	return `${model.provider}${SEPARATOR}${model.modelId}`;
}

export function parseModelKey(key: string): ModelRef {
	const index = key.indexOf(SEPARATOR);
	if (index < 0) return { provider: key, modelId: "" };
	return { provider: key.slice(0, index), modelId: key.slice(index + 1) };
}

/** Models grouped by provider; a current value that is no longer offered stays selectable. */
export function groupModels(models: AvailableModel[], current?: ModelRef): Map<string, AvailableModel[]> {
	const groups = new Map<string, AvailableModel[]>();
	const all =
		current !== undefined && !models.some((model) => modelKey(model) === modelKey(current))
			? [...models, { ...current, name: current.modelId, contextWindow: 0 }]
			: models;
	for (const model of all) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
	return groups;
}

export interface ModelSelectProps {
	models: AvailableModel[];
	value: ModelRef | undefined;
	onChange: (model: ModelRef) => void;
	label?: string;
	disabled?: boolean;
	id?: string;
	placeholder?: string;
	className?: string;
	/** `inline` drops the form-field chrome for a composer footer trigger. */
	variant?: "default" | "inline";
	title?: string;
	dataTestId?: string;
}

/** A grouped model picker shared by the session, schedule and batch forms. */
export function ModelSelect({
	models,
	value,
	onChange,
	label,
	disabled,
	id,
	placeholder,
	className,
	variant = "default",
	title,
	dataTestId,
}: ModelSelectProps) {
	const inline = variant === "inline";
	const { t } = useLingui();
	const groups = groupModels(models, value);
	const selected = value ? modelKey(value) : "";
	return (
		<Select
			value={selected === "" ? null : selected}
			onValueChange={(next) => {
				if (typeof next === "string" && next !== "") onChange(parseModelKey(next));
			}}
			disabled={disabled}
		>
			<SelectTrigger
				id={id}
				aria-label={label ?? t`Model`}
				title={title}
				size={inline ? "xs" : "default"}
				showIcon={!inline}
				data-testid={dataTestId}
				className={cn(
					"w-full",
					inline &&
						"w-fit min-w-0 shrink justify-start gap-1 border-0 bg-transparent px-2 font-mono text-xs font-normal shadow-none hover:bg-muted aria-expanded:bg-muted [&>svg]:hidden",
					className,
				)}
			>
				<SelectValue placeholder={placeholder ?? t`Choose a model`}>
					{(current: string | null) => {
						if (!current) return placeholder ?? t`Choose a model`;
						const parsed = parseModelKey(current);
						if (inline) {
							return (
								<span className="min-w-0 truncate">
									{parsed.provider}/{parsed.modelId}
								</span>
							);
						}
						const hit = models.find((model) => model.provider === parsed.provider && model.modelId === parsed.modelId);
						return hit?.name ?? parsed.modelId;
					}}
				</SelectValue>
			</SelectTrigger>
			<SelectContent
				side={inline ? "top" : undefined}
				align={inline ? "start" : undefined}
				alignItemWithTrigger={inline ? false : undefined}
				className={inline ? "w-72" : undefined}
			>
				{[...groups].map(([provider, list]) => (
					<SelectGroup key={provider}>
						<SelectLabel>{provider}</SelectLabel>
						{list.map((model) => (
							<SelectItem key={modelKey(model)} value={modelKey(model)}>
								{model.name}
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}
