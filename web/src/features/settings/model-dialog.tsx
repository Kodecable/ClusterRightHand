import { useLingui } from "@lingui/react/macro";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { FieldShell } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogScrollArea,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { CustomApi, ThinkingLevel } from "@/lib/api/types";
import {
	type FormatLevelKind,
	type ModelFormErrors,
	type ModelRow,
	providerErrorText,
	rowToModel,
	THINKING_FORMATS,
	THINKING_LEVELS,
	type ThinkingMode,
} from "./providers";

interface SelectOption {
	value: string;
	label: ReactNode;
}

function SelectInput({
	label,
	value,
	onChange,
	options,
	description,
	error,
}: {
	label: ReactNode;
	value: string;
	onChange: (value: string) => void;
	options: readonly SelectOption[];
	description?: ReactNode;
	error?: string;
}) {
	const id = useId();
	return (
		<FieldShell id={id} label={label} description={description} error={error}>
			<Select value={value === "" ? null : value} onValueChange={(next) => onChange(next ?? "")}>
				<SelectTrigger id={id} className="w-full" aria-invalid={error !== undefined || undefined}>
					<SelectValue>
						{(selected: string | null) => options.find((option) => option.value === selected)?.label ?? selected ?? ""}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</FieldShell>
	);
}

function ErrorText({ children }: { children: ReactNode }) {
	return (
		<p role="alert" className="text-xs text-danger">
			{children}
		</p>
	);
}

/**
 * The level mapping of the standard mode: each row is omitted ("default") or a mapped string
 * value. The display name input carries the level: `minimal`–`high` default to the level id and
 * show it as their placeholder, while `xhigh`/`max` start empty (hidden) because pi-ai offers
 * them only when they are mapped or named. An empty name hides the level.
 */
function FormatLevelTable({
	row,
	errors,
	patchLevel,
	patchLabel,
}: {
	row: ModelRow;
	errors: ModelFormErrors;
	patchLevel: (level: ThinkingLevel, next: { kind?: FormatLevelKind; value?: string }) => void;
	patchLabel: (level: ThinkingLevel, label: string) => void;
}) {
	const { t, i18n } = useLingui();
	const kindLabel = (kind: FormatLevelKind) => (kind === "default" ? t`Default (omitted)` : t`Mapped value`);
	return (
		<>
			<Label>{t`Level mapping`}</Label>
			<div className="overflow-auto rounded-lg border">
				<Table aria-label={t`Thinking level mapping`}>
					<TableHeader>
						<TableRow>
							<TableHead className="w-40">{t`Display name`}</TableHead>
							<TableHead className="w-44">{t`Mapping`}</TableHead>
							<TableHead>{t`Value`}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{THINKING_LEVELS.map((level) => {
							const entry = row.formatLevels[level];
							const error = errors.formatLevels?.[level];
							const labelError = errors.labels?.[level];
							return (
								<TableRow key={level}>
									<TableCell>
										<Input
											aria-label={t`${level} display name`}
											placeholder={level}
											aria-invalid={labelError !== undefined || undefined}
											value={row.labels[level]}
											onChange={(event) => patchLabel(level, event.target.value)}
										/>
										{labelError !== undefined && <ErrorText>{providerErrorText(i18n, labelError)}</ErrorText>}
									</TableCell>
									<TableCell>
										<Select
											value={entry.kind}
											onValueChange={(next) => patchLevel(level, { kind: next as FormatLevelKind })}
										>
											<SelectTrigger size="sm" className="w-full" aria-label={t`${level} mapping`}>
												<SelectValue>{(selected: FormatLevelKind) => kindLabel(selected)}</SelectValue>
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="default">{t`Default (omitted)`}</SelectItem>
												<SelectItem value="value">{t`Mapped value`}</SelectItem>
											</SelectContent>
										</Select>
									</TableCell>
									<TableCell>
										<Input
											aria-label={t`${level} value`}
											aria-invalid={error !== undefined || undefined}
											disabled={entry.kind !== "value"}
											value={entry.value}
											onChange={(event) => patchLevel(level, { value: event.target.value })}
										/>
										{error !== undefined && <ErrorText>{providerErrorText(i18n, error)}</ErrorText>}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
		</>
	);
}

/** The custom (request-body) mode: one optional JSON object and display name per level. */
function BodyLevelRows({
	row,
	errors,
	patchLevel,
	patchLabel,
}: {
	row: ModelRow;
	errors: ModelFormErrors;
	patchLevel: (level: ThinkingLevel, text: string) => void;
	patchLabel: (level: ThinkingLevel, label: string) => void;
}) {
	const { t, i18n } = useLingui();
	return (
		<div className="grid gap-2">
			<div>
				<Label>{t`Request body per level`}</Label>
				<p className="text-xs text-muted-foreground">
					{t`Each level's JSON object is merged into the request body; a level is offered only with a body and a display name.`}
				</p>
			</div>
			<div className="hidden grid-cols-[10rem_1fr] gap-2 text-xs text-muted-foreground sm:grid">
				<span>{t`Display name`}</span>
				<span>{t`Request body (JSON)`}</span>
			</div>
			{THINKING_LEVELS.map((level) => {
				const error = errors.bodyLevels?.[level];
				const labelError = errors.labels?.[level];
				return (
					<div key={level} className="grid gap-2 sm:grid-cols-[10rem_1fr]">
						<div className="grid gap-1">
							<Input
								aria-label={t`${level} display name`}
								placeholder={level}
								aria-invalid={labelError !== undefined || undefined}
								value={row.labels[level]}
								onChange={(event) => patchLabel(level, event.target.value)}
							/>
							{labelError !== undefined && <ErrorText>{providerErrorText(i18n, labelError)}</ErrorText>}
						</div>
						<div className="grid gap-1">
							<Textarea
								aria-label={t`${level} request body JSON`}
								aria-invalid={error !== undefined || undefined}
								className="font-mono text-xs"
								rows={2}
								placeholder="{}"
								value={row.bodyLevels[level]}
								onChange={(event) => patchLevel(level, event.target.value)}
							/>
							{error !== undefined && <ErrorText>{providerErrorText(i18n, error)}</ErrorText>}
						</div>
					</div>
				);
			})}
		</div>
	);
}

/** The "auto" choice of the format select: the payload omits `format` entirely. */
const AUTO_FORMAT = "__auto";

/**
 * The model editor of a custom provider (doc/agent-runtime.md#自定义提供方): all pi-ai fields,
 * including both thinking modes and the advanced compat JSON. It is a dialog nested in the
 * provider dialog (Base UI nested dialogs); the header and footer stay fixed while the body
 * scrolls inside the popup's rounded frame.
 */
export function ModelDialog({
	initial,
	editing,
	onClose,
	onSave,
}: {
	initial: ModelRow;
	editing: boolean;
	onClose: () => void;
	onSave: (model: ModelRow) => void;
}) {
	const { t, i18n } = useLingui();
	const prefix = useId();
	const [row, setRow] = useState<ModelRow>(initial);
	const [errors, setErrors] = useState<ModelFormErrors>({});

	const patch = (next: Partial<ModelRow>) => setRow((current) => ({ ...current, ...next }));
	const patchFormatLevel = (level: ThinkingLevel, next: { kind?: FormatLevelKind; value?: string }) =>
		setRow((current) => ({
			...current,
			formatLevels: { ...current.formatLevels, [level]: { ...current.formatLevels[level], ...next } },
		}));
	const patchBodyLevel = (level: ThinkingLevel, text: string) =>
		setRow((current) => ({ ...current, bodyLevels: { ...current.bodyLevels, [level]: text } }));
	const patchLabel = (level: ThinkingLevel, label: string) =>
		setRow((current) => ({ ...current, labels: { ...current.labels, [level]: label } }));

	const submit = () => {
		const converted = rowToModel(row);
		if ("errors" in converted) {
			setErrors(converted.errors);
			return;
		}
		setErrors({});
		onSave(row);
	};

	const apiOptions: readonly SelectOption[] = [
		{ value: "openai-completions", label: t`Chat Completions` },
		{ value: "openai-responses", label: t`Responses` },
	];
	const thinkingOptions: readonly SelectOption[] = [
		{ value: "none", label: t`None` },
		{ value: "standard", label: t`Standard` },
		{ value: "custom", label: t`Custom` },
	];
	const formatOptions: readonly SelectOption[] = [
		{ value: AUTO_FORMAT, label: t`Auto (omit)` },
		...THINKING_FORMATS.map((format) => ({ value: format, label: format })),
	];

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				className="flex max-h-[90vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
				data-testid="model-dialog"
			>
				<DialogHeader className="border-b p-4 pr-12">
					<DialogTitle>{editing ? t`Edit model ${initial.id}` : t`Add model`}</DialogTitle>
				</DialogHeader>
				<DialogScrollArea className="mx-0 my-0 grid min-h-0 flex-1 content-start gap-4 px-4 py-4">
					<div className="grid gap-3 sm:grid-cols-2">
						<FieldShell id={`${prefix}-id`} label={t`Model id`} error={errorText(i18n, errors.id)}>
							<Input
								id={`${prefix}-id`}
								value={row.id}
								aria-invalid={errors.id !== undefined || undefined}
								onChange={(event) => patch({ id: event.target.value })}
							/>
						</FieldShell>
						<FieldShell id={`${prefix}-name`} label={t`Display name`}>
							<Input id={`${prefix}-name`} value={row.name} onChange={(event) => patch({ name: event.target.value })} />
						</FieldShell>
						<SelectInput
							label={t`Protocol`}
							value={row.api}
							onChange={(api) => patch({ api: api as CustomApi })}
							options={apiOptions}
						/>
						<div className="grid grid-cols-2 gap-3">
							<FieldShell
								id={`${prefix}-context`}
								label={t`Context window`}
								error={errorText(i18n, errors.contextWindow)}
							>
								<Input
									id={`${prefix}-context`}
									inputMode="numeric"
									value={row.contextWindow}
									aria-invalid={errors.contextWindow !== undefined || undefined}
									onChange={(event) => patch({ contextWindow: event.target.value })}
								/>
							</FieldShell>
							<FieldShell id={`${prefix}-max`} label={t`Max output tokens`} error={errorText(i18n, errors.maxTokens)}>
								<Input
									id={`${prefix}-max`}
									inputMode="numeric"
									value={row.maxTokens}
									aria-invalid={errors.maxTokens !== undefined || undefined}
									onChange={(event) => patch({ maxTokens: event.target.value })}
								/>
							</FieldShell>
						</div>
					</div>

					<div className="flex items-center gap-2">
						<Checkbox
							id={`${prefix}-images`}
							checked={row.imageUnderstanding}
							onCheckedChange={(checked) => patch({ imageUnderstanding: Boolean(checked) })}
						/>
						<Label htmlFor={`${prefix}-images`}>{t`Image understanding`}</Label>
					</div>

					<SelectInput
						label={t`Thinking`}
						value={row.thinkingMode}
						onChange={(mode) => patch({ thinkingMode: mode as ThinkingMode })}
						options={thinkingOptions}
					/>

					{row.thinkingMode === "standard" && (
						<div className="grid gap-3">
							{row.api === "openai-completions" && (
								<SelectInput
									label={t`Thinking format`}
									value={row.format === "" ? AUTO_FORMAT : row.format}
									onChange={(format) => patch({ format: format === AUTO_FORMAT ? "" : format })}
									options={formatOptions}
									description={t`Auto lets pi-ai decide from the base URL. Responses always sends reasoning.effort.`}
								/>
							)}
							<FormatLevelTable row={row} errors={errors} patchLevel={patchFormatLevel} patchLabel={patchLabel} />
						</div>
					)}

					{row.thinkingMode === "custom" && (
						<BodyLevelRows row={row} errors={errors} patchLevel={patchBodyLevel} patchLabel={patchLabel} />
					)}

					<Collapsible>
						<CollapsibleTrigger className="flex w-fit items-center gap-1 text-sm font-medium">
							<ChevronRightIcon className="size-4" />
							{t`Compat (JSON, advanced)`}
						</CollapsibleTrigger>
						<CollapsibleContent className="grid gap-1 pt-2">
							<p className="text-xs text-muted-foreground">
								{t`Advanced pi-ai options, validated against the protocol's schema. Leave empty for auto-detection.`}
							</p>
							<Textarea
								aria-label={t`Compat JSON`}
								aria-invalid={errors.compat !== undefined || undefined}
								className="font-mono text-xs"
								rows={4}
								placeholder="{}"
								value={row.compatText}
								onChange={(event) => patch({ compatText: event.target.value })}
							/>
							{errors.compat !== undefined && <ErrorText>{providerErrorText(i18n, errors.compat)}</ErrorText>}
						</CollapsibleContent>
					</Collapsible>
				</DialogScrollArea>
				<DialogFooter className="mx-0 mb-0 rounded-none">
					<Button type="button" variant="outline" onClick={onClose}>
						{t`Cancel`}
					</Button>
					<Button type="button" onClick={submit}>
						{t`Save model`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function errorText(
	i18n: ReturnType<typeof useLingui>["i18n"],
	code: Parameters<typeof providerErrorText>[1] | undefined,
) {
	return code === undefined ? undefined : providerErrorText(i18n, code);
}
