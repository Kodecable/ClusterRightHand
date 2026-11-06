import { useLingui } from "@lingui/react/macro";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { FieldShell } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
 * The level mapping of the format mode: each row is omitted ("default"), a
 * mapped string value, or `null` ("disabled"), matching pi-ai's thinkingLevelMap.
 */
function FormatLevelTable({
	row,
	errors,
	patchLevel,
}: {
	row: ModelRow;
	errors: ModelFormErrors;
	patchLevel: (level: ThinkingLevel, next: { kind?: FormatLevelKind; value?: string }) => void;
}) {
	const { t, i18n } = useLingui();
	const kindLabel = (kind: FormatLevelKind) =>
		kind === "default" ? t`Default (omitted)` : kind === "value" ? t`Mapped value` : t`Disabled (null)`;
	return (
		<>
			<Label>{t`Level mapping`}</Label>
			<div className="overflow-auto rounded-lg border">
				<Table aria-label={t`Thinking level mapping`}>
					<TableHeader>
						<TableRow>
							<TableHead className="w-16">{t`Level`}</TableHead>
							<TableHead className="w-44">{t`Mapping`}</TableHead>
							<TableHead>{t`Value`}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{THINKING_LEVELS.map((level) => {
							const entry = row.formatLevels[level];
							const error = errors.formatLevels?.[level];
							return (
								<TableRow key={level}>
									<TableCell>
										<code className="font-mono text-xs">{level}</code>
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
												<SelectItem value="disabled">{t`Disabled (null)`}</SelectItem>
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

/** The request-body mode: one optional JSON object per level (empty means not offered). */
function BodyLevelRows({
	row,
	errors,
	patchLevel,
	prefix,
}: {
	row: ModelRow;
	errors: ModelFormErrors;
	patchLevel: (level: ThinkingLevel, text: string) => void;
	prefix: string;
}) {
	const { t, i18n } = useLingui();
	return (
		<div className="grid gap-2">
			<div>
				<Label>{t`Request body per level`}</Label>
				<p className="text-xs text-muted-foreground">
					{t`Each level's JSON object is merged into the request body; leave a level empty to not offer it.`}
				</p>
			</div>
			{THINKING_LEVELS.map((level) => {
				const id = `${prefix}-body-${level}`;
				const error = errors.bodyLevels?.[level];
				return (
					<div key={level} className="grid grid-cols-[3.5rem_1fr] items-start gap-2">
						<Label htmlFor={id} className="pt-2 font-mono text-xs">
							{level}
						</Label>
						<div className="grid gap-1">
							<Textarea
								id={id}
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
 * The model sheet of a custom provider (doc/agent-runtime.md#自定义提供方): all
 * pi-ai fields, including both thinking modes and the advanced compat JSON.
 * It is a sheet rather than a second dialog so the wide level tables fit.
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
		{ value: "format", label: t`Format mode` },
		{ value: "body", label: t`Request body mode` },
	];
	const formatOptions: readonly SelectOption[] = [
		{ value: AUTO_FORMAT, label: t`Auto (omit)` },
		...THINKING_FORMATS.map((format) => ({ value: format, label: format })),
	];

	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<SheetContent side="right" className="w-full gap-0 sm:max-w-2xl" data-testid="model-dialog">
				<SheetHeader className="border-b pr-12">
					<SheetTitle>{editing ? t`Edit model ${initial.id}` : t`Add model`}</SheetTitle>
					<SheetDescription>
						{t`Models of this provider are offered to sessions; each one maps to the fields pi-ai needs.`}
					</SheetDescription>
				</SheetHeader>
				<div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-4">
					<div className="grid gap-3 sm:grid-cols-2">
						<FieldShell id={`${prefix}-id`} label={t`Model id`} error={errorText(i18n, errors.id)}>
							<Input
								id={`${prefix}-id`}
								value={row.id}
								aria-invalid={errors.id !== undefined || undefined}
								onChange={(event) => patch({ id: event.target.value })}
							/>
						</FieldShell>
						<FieldShell
							id={`${prefix}-name`}
							label={t`Display name`}
							description={t`Optional; defaults to the model id.`}
						>
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
							checked={row.acceptImages}
							onCheckedChange={(checked) => patch({ acceptImages: Boolean(checked) })}
						/>
						<Label htmlFor={`${prefix}-images`}>{t`Accept images`}</Label>
					</div>

					<SelectInput
						label={t`Thinking`}
						value={row.thinkingMode}
						onChange={(mode) => patch({ thinkingMode: mode as ThinkingMode })}
						options={thinkingOptions}
					/>

					{row.thinkingMode === "format" && (
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
							<FormatLevelTable row={row} errors={errors} patchLevel={patchFormatLevel} />
						</div>
					)}

					{row.thinkingMode === "body" && (
						<BodyLevelRows row={row} errors={errors} patchLevel={patchBodyLevel} prefix={prefix} />
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
				</div>
				<SheetFooter className="border-t">
					<Button type="button" variant="outline" onClick={onClose}>
						{t`Cancel`}
					</Button>
					<Button type="button" onClick={submit}>
						{t`Save model`}
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}

function errorText(
	i18n: ReturnType<typeof useLingui>["i18n"],
	code: Parameters<typeof providerErrorText>[1] | undefined,
) {
	return code === undefined ? undefined : providerErrorText(i18n, code);
}
