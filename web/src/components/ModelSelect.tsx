import type { AvailableModel, ModelRef } from "../api.ts";

const SEP = "\u0000";
const key = (m: ModelRef) => `${m.provider}${SEP}${m.modelId}`;

/** Models grouped by provider; a current value that is no longer offered stays selectable. */
export function groupModels(models: AvailableModel[], current?: ModelRef): Map<string, AvailableModel[]> {
	const groups = new Map<string, AvailableModel[]>();
	const all =
		current && !models.some((m) => key(m) === key(current))
			? [...models, { ...current, name: current.modelId, contextWindow: 0 }]
			: models;
	for (const m of all) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
	return groups;
}

export function ModelSelect({
	models,
	value,
	onChange,
	label = "Model",
	disabled,
}: {
	models: AvailableModel[];
	value: ModelRef | undefined;
	onChange: (m: ModelRef) => void;
	label?: string;
	disabled?: boolean;
}) {
	const groups = groupModels(models, value);
	return (
		<label>
			{label}
			<select
				aria-label={label}
				value={value ? key(value) : ""}
				disabled={disabled}
				onChange={(e) => {
					const [provider, modelId] = e.target.value.split(SEP) as [string, string];
					onChange({ provider, modelId });
				}}
			>
				{!value && <option value="">Choose a model</option>}
				{[...groups].map(([provider, list]) => (
					<optgroup key={provider} label={provider}>
						{list.map((m) => (
							<option key={key(m)} value={key(m)}>
								{m.name}
							</option>
						))}
					</optgroup>
				))}
			</select>
		</label>
	);
}

export function PresetSelect({
	value,
	onChange,
	disabled,
}: {
	value: "ask" | "auto_review" | "yolo";
	onChange: (p: "ask" | "auto_review" | "yolo") => void;
	disabled?: boolean;
}) {
	return (
		<label>
			Preset
			<select
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value as "ask" | "auto_review" | "yolo")}
			>
				<option value="ask">Ask</option>
				<option value="auto_review" disabled>
					Auto Review (coming later)
				</option>
				<option value="yolo">Yolo</option>
			</select>
		</label>
	);
}
