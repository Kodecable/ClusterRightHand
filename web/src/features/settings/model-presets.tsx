import type { AvailableModel, ModelPreset, ModelRef, ThinkingLevel } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { groupModels, modelKey, parseModelKey } from "@/components/model-select";
import { ThinkingLevelSelect } from "@/components/thinking-level-select";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { availableModel, supportedThinkingLevels, withThinkingLevel } from "@/lib/thinking-level";
import { useModelPresets, useModels, useSaveModelPreset } from "./api";

const NONE = "__session__";

/** The model page's three model presets (D116, doc/webui.md "模型页"). */
export function ModelPresetsSection() {
	const { t } = useLingui();
	const presets = useModelPresets();
	const models = useModels();

	return (
		<section className="grid gap-3" aria-labelledby="model-presets-heading" data-testid="model-presets">
			<div>
				<h2 id="model-presets-heading" className="text-sm font-semibold">
					<Trans>Model presets</Trans>
				</h2>
				<p className="text-sm text-muted-foreground">
					<Trans>Changes take effect on the next model request.</Trans>
				</p>
			</div>
			{presets.isLoading && (
				<p className="text-sm text-muted-foreground">
					<Trans>Loading…</Trans>
				</p>
			)}
			{presets.isError && (
				<p role="alert" className="text-sm text-danger">
					{presets.error.message}
				</p>
			)}
			<div className="grid gap-3 lg:grid-cols-3">
				{(presets.data ?? []).map((preset) => (
					<ModelPresetCard key={preset.kind} preset={preset} models={models.data ?? []} />
				))}
			</div>
			{models.isError && (
				<p role="alert" className="text-sm text-danger">
					{t`The model list could not be loaded.`}
				</p>
			)}
		</section>
	);
}

function ModelPresetCard({ preset, models }: { preset: ModelPreset; models: AvailableModel[] }) {
	const { t } = useLingui();
	const save = useSaveModelPreset();
	const [model, setModel] = useState<ModelRef | null>(preset.model);
	const [level, setLevel] = useState<ThinkingLevel>(preset.model?.thinkingLevel ?? "off");
	const [prompt, setPrompt] = useState(preset.systemPrompt ?? "");

	// A save refreshes the query; take the stored values back (another tab may have changed them too).
	useEffect(() => {
		setModel(preset.model);
		setLevel(preset.model?.thinkingLevel ?? "off");
		setPrompt(preset.systemPrompt ?? "");
	}, [preset]);

	const currentModel = availableModel(models, model ?? undefined);
	const levels = supportedThinkingLevels(models, model ?? undefined);
	const currentLevel = levels.includes(level) ? level : (levels[0] ?? "off");
	const title =
		preset.kind === "session" ? t`Session` : preset.kind === "review" ? t`Auto review` : t`Title generation`;

	const chooseModel = (key: string) => {
		if (key === NONE) {
			setModel(null);
			return;
		}
		const next = parseModelKey(key);
		setModel(next);
		const nextLevels = supportedThinkingLevels(models, next);
		if (!nextLevels.includes(level)) setLevel(nextLevels[0] ?? "off");
	};

	const submit = () => {
		const systemPrompt = prompt.trim() === "" ? null : prompt;
		if (preset.kind === "session") {
			save.mutate({ kind: preset.kind, input: { systemPrompt } }, { onSuccess: () => toast.success(t`Preset saved.`) });
			return;
		}
		const inputModel = preset.kind === "review" && model !== null ? withThinkingLevel(model, currentLevel) : model;
		save.mutate(
			{ kind: preset.kind, input: { model: inputModel, systemPrompt } },
			{ onSuccess: () => toast.success(t`Preset saved.`) },
		);
	};

	return (
		<section
			className="grid content-start gap-3 rounded-lg border p-4"
			aria-labelledby={`model-preset-${preset.kind}-heading`}
			data-testid={`model-preset-${preset.kind}`}
		>
			<div className="flex items-start justify-between gap-2">
				<h3 id={`model-preset-${preset.kind}-heading`} className="text-sm font-semibold">
					{title}
				</h3>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={save.isPending}
					onClick={submit}
					data-testid={`save-model-preset-${preset.kind}`}
				>
					<Trans>Save</Trans>
				</Button>
			</div>

			{preset.kind !== "session" && (
				<div className="grid gap-1.5">
					<Label htmlFor={`model-preset-${preset.kind}-model`}>{t`Model`}</Label>
					<Select value={model === null ? NONE : modelKey(model)} onValueChange={(next) => chooseModel(String(next))}>
						<SelectTrigger id={`model-preset-${preset.kind}-model`} className="w-full">
							<SelectValue>
								{(current: string | null) => {
									if (current === null || current === NONE) return t`Use the session's model`;
									const parsed = parseModelKey(current);
									const hit = models.find(
										(candidate) => candidate.provider === parsed.provider && candidate.modelId === parsed.modelId,
									);
									return hit?.name ?? parsed.modelId;
								}}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NONE}>{t`Use the session's model`}</SelectItem>
							{[...groupModels(models, model ?? undefined)].map(([provider, list]) => (
								<SelectGroup key={provider}>
									<SelectLabel>{provider}</SelectLabel>
									{list.map((candidate) => (
										<SelectItem key={modelKey(candidate)} value={modelKey(candidate)}>
											{candidate.name}
										</SelectItem>
									))}
								</SelectGroup>
							))}
						</SelectContent>
					</Select>
				</div>
			)}

			{preset.kind === "review" && model !== null && (
				<div className="grid gap-1.5">
					<Label htmlFor={`model-preset-${preset.kind}-thinking`}>{t`Thinking level`}</Label>
					<ThinkingLevelSelect
						id={`model-preset-${preset.kind}-thinking`}
						model={currentModel}
						levels={levels}
						value={currentLevel}
						onChange={setLevel}
					/>
				</div>
			)}

			<div className="grid gap-1.5">
				<Label htmlFor={`model-preset-${preset.kind}-prompt`}>{t`System prompt`}</Label>
				<Textarea
					id={`model-preset-${preset.kind}-prompt`}
					rows={4}
					value={prompt}
					placeholder={t`Leave empty to use the default prompt.`}
					onChange={(event) => setPrompt(event.target.value)}
				/>
			</div>

			<Collapsible>
				<CollapsibleTrigger className="flex w-fit items-center gap-1 text-sm font-medium">
					<ChevronRightIcon className="size-4" />
					{t`Default prompt and protocol`}
				</CollapsibleTrigger>
				<CollapsibleContent className="grid gap-2 pt-2">
					<div className="grid gap-1">
						<p className="text-xs font-medium text-muted-foreground">{t`Default prompt`}</p>
						<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
							{preset.defaultPrompt}
						</pre>
					</div>
					<div className="grid gap-1">
						<p className="text-xs font-medium text-muted-foreground">{t`Always appended`}</p>
						<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
							{preset.protocol}
						</pre>
					</div>
				</CollapsibleContent>
			</Collapsible>

			{save.error !== null && (
				<p role="alert" className="text-sm text-danger">
					{save.error.message}
				</p>
			)}
		</section>
	);
}
