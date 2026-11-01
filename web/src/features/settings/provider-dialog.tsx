import { zodResolver } from "@hookform/resolvers/zod";
import type { I18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useMemo } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormDialog } from "@/components/dialogs";
import { CheckboxField, SelectField, TextareaField, TextField } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ModelProviderInput, ModelProviderView } from "@/lib/api/types";
import { useSaveModelProvider } from "./api";
import { type ModelRow, PROVIDER_ID_PATTERN, parseHeaders, providerErrorText, rowsToModels } from "./providers";

interface ProviderValues {
	kind: "builtin" | "openai-compatible";
	providerId: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	removeKey: boolean;
	enabled: boolean;
	headersText: string;
	models: ModelRow[];
}

const row = (model?: { id: string; contextWindow: number; maxTokens: number; reasoning?: boolean }): ModelRow => ({
	id: model?.id ?? "",
	contextWindow: String(model?.contextWindow ?? 128_000),
	maxTokens: String(model?.maxTokens ?? 8_192),
	reasoning: model?.reasoning === true,
});

function providerValues(provider: ModelProviderView | undefined, builtin: string[]): ProviderValues {
	return {
		kind: provider?.kind ?? "builtin",
		providerId: provider?.providerId ?? builtin[0] ?? "",
		name: provider?.name ?? "",
		baseUrl: provider?.baseUrl ?? "",
		// The stored key is never sent back by the API, so this field always
		// starts empty; leaving it empty keeps the current key.
		apiKey: "",
		removeKey: false,
		enabled: provider?.enabled ?? true,
		headersText: provider?.headers ? JSON.stringify(provider.headers, null, 2) : "",
		models: provider?.models?.length ? provider.models.map((model) => row(model)) : [row()],
	};
}

function buildSchema(i18n: I18n) {
	const message = (code: Parameters<typeof providerErrorText>[1]) => providerErrorText(i18n, code);
	return z
		.object({
			kind: z.enum(["builtin", "openai-compatible"]),
			providerId: z.string(),
			name: z.string(),
			baseUrl: z.string(),
			apiKey: z.string(),
			removeKey: z.boolean(),
			enabled: z.boolean(),
			headersText: z.string(),
			models: z.array(
				z.object({
					id: z.string(),
					contextWindow: z.string(),
					maxTokens: z.string(),
					reasoning: z.boolean(),
				}),
			),
		})
		.superRefine((values, context) => {
			if (!PROVIDER_ID_PATTERN.test(values.providerId)) {
				context.addIssue({
					code: "custom",
					path: ["providerId"],
					message: message("provider-id-invalid"),
				});
			}
			if (values.kind !== "openai-compatible") return;
			const baseUrl = values.baseUrl.trim();
			if (baseUrl === "") {
				context.addIssue({ code: "custom", path: ["baseUrl"], message: message("base-url-required") });
			} else if (!/^https?:\/\//.test(baseUrl)) {
				context.addIssue({ code: "custom", path: ["baseUrl"], message: message("base-url-invalid") });
			}
			const models = rowsToModels(values.models);
			if ("error" in models) {
				context.addIssue({ code: "custom", path: ["models"], message: message(models.error) });
			}
			const headers = parseHeaders(values.headersText);
			if ("error" in headers) {
				context.addIssue({ code: "custom", path: ["headersText"], message: message(headers.error) });
			}
		});
}

/** The provider form's model rows: id, context window, max output tokens and reasoning. */
function ModelRows({ form }: { form: ReturnType<typeof useForm<ProviderValues>> }) {
	const { t } = useLingui();
	const { fields, append, remove } = useFieldArray({ control: form.control, name: "models" });
	const prefix = useId();
	return (
		<fieldset className="grid gap-2">
			<legend className="text-sm font-medium">{t`Models`}</legend>
			<div className="overflow-auto rounded-lg border">
				<Table aria-label={t`Models`}>
					<TableHeader>
						<TableRow>
							<TableHead>{t`Id`}</TableHead>
							<TableHead>{t`Context window`}</TableHead>
							<TableHead>{t`Max tokens`}</TableHead>
							<TableHead>{t`Reasoning`}</TableHead>
							<TableHead className="w-16" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{fields.map((field, index) => (
							<TableRow key={field.id}>
								<TableCell>
									<Input
										id={`${prefix}-model-${index}-id`}
										aria-label={t`Model ${index + 1} id`}
										value={form.watch(`models.${index}.id`)}
										onChange={(event) => form.setValue(`models.${index}.id`, event.target.value)}
									/>
								</TableCell>
								<TableCell>
									<Input
										id={`${prefix}-model-${index}-context`}
										aria-label={t`Model ${index + 1} context window`}
										inputMode="numeric"
										value={form.watch(`models.${index}.contextWindow`)}
										onChange={(event) => form.setValue(`models.${index}.contextWindow`, event.target.value)}
									/>
								</TableCell>
								<TableCell>
									<Input
										id={`${prefix}-model-${index}-max`}
										aria-label={t`Model ${index + 1} max tokens`}
										inputMode="numeric"
										value={form.watch(`models.${index}.maxTokens`)}
										onChange={(event) => form.setValue(`models.${index}.maxTokens`, event.target.value)}
									/>
								</TableCell>
								<TableCell>
									<input
										type="checkbox"
										aria-label={t`Model ${index + 1} reasoning`}
										checked={form.watch(`models.${index}.reasoning`)}
										onChange={(event) => form.setValue(`models.${index}.reasoning`, event.target.checked)}
									/>
								</TableCell>
								<TableCell>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={t`Remove model ${index + 1}`}
										disabled={fields.length === 1}
										onClick={() => remove(index)}
									>
										<Trash2Icon />
									</Button>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			<div>
				<Button type="button" size="sm" variant="outline" onClick={() => append(row())}>
					<PlusIcon />
					<Trans>Add model</Trans>
				</Button>
			</div>
			{form.formState.errors.models?.message !== undefined && (
				<p role="alert" className="text-xs text-danger">
					{form.formState.errors.models.message}
				</p>
			)}
		</fieldset>
	);
}

/** The add/edit dialog of one model provider; the API key is never prefilled. */
export function ProviderDialog({
	existing,
	builtin,
	onClose,
	onSaved,
}: {
	existing: ModelProviderView | undefined;
	builtin: string[];
	onClose: () => void;
	onSaved: () => void;
}) {
	const { t, i18n } = useLingui();
	const prefix = useId();
	const save = useSaveModelProvider();
	const schema = useMemo(() => buildSchema(i18n), [i18n]);
	const form = useForm<ProviderValues>({
		resolver: zodResolver(schema),
		defaultValues: providerValues(existing, builtin),
	});
	const kind = form.watch("kind");
	const editing = existing !== undefined;

	const submit = form.handleSubmit((values) => {
		const body: ModelProviderInput = { kind: values.kind, enabled: values.enabled };
		if (values.kind === "openai-compatible") {
			const models = rowsToModels(values.models);
			const headers = parseHeaders(values.headersText);
			if ("error" in models || "error" in headers) return;
			body.name = values.name.trim() || values.providerId;
			body.baseUrl = values.baseUrl.trim();
			body.models = models.models;
			body.headers = headers.headers;
		}
		if (values.removeKey) body.apiKey = null;
		else if (values.apiKey !== "") body.apiKey = values.apiKey;
		save.mutate(
			{ providerId: values.providerId, body },
			{
				onSuccess: () => {
					toast.success(t`Provider saved.`);
					onSaved();
					onClose();
				},
			},
		);
	});

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={editing ? t`Edit provider ${existing.providerId}` : t`Add model provider`}
			description={<Trans>Sessions use the models of the enabled providers.</Trans>}
			submitLabel={<Trans>Save provider</Trans>}
			busy={save.isPending}
			submitDisabled={form.watch("providerId") === ""}
			error={save.error !== null ? save.error.message : undefined}
			testId="provider-dialog"
			className="sm:max-w-2xl"
			onSubmit={() => void submit()}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<SelectField
					control={form.control}
					name="kind"
					label={t`Kind`}
					disabled={editing}
					options={[
						{ value: "builtin", label: t`Built-in provider` },
						{ value: "openai-compatible", label: t`OpenAI-compatible endpoint` },
					]}
				/>
				{kind === "builtin" ? (
					<SelectField
						control={form.control}
						name="providerId"
						label={t`Provider`}
						disabled={editing}
						options={builtin.map((id) => ({ value: id, label: id }))}
					/>
				) : (
					<TextField
						control={form.control}
						name="providerId"
						label={t`Provider id`}
						description={t`Lowercase letters, digits and dashes.`}
						disabled={editing}
					/>
				)}
			</div>

			{kind === "openai-compatible" && (
				<>
					<div className="grid gap-3 sm:grid-cols-2">
						<TextField
							control={form.control}
							name="name"
							label={t`Name`}
							description={t`Optional; defaults to the provider id.`}
						/>
						<TextField
							control={form.control}
							name="baseUrl"
							type="url"
							label={t`Base URL`}
							placeholder="https://api.example.com/v1"
						/>
					</div>
					<ModelRows form={form} />
					<TextareaField
						control={form.control}
						name="headersText"
						label={t`Request headers (JSON, optional)`}
						rows={3}
						placeholder={'{"x-opencode-session": "crhs"}'}
						description={t`Extra headers for gateways; credentials belong in the API key field.`}
					/>
				</>
			)}

			<div className="grid gap-1.5">
				<Label htmlFor={`${prefix}-api-key`}>{t`API key`}</Label>
				<Input
					id={`${prefix}-api-key`}
					type="password"
					autoComplete="off"
					value={form.watch("apiKey")}
					disabled={form.watch("removeKey")}
					placeholder={existing?.hasApiKey ? t`Leave empty to keep the current key` : t`Optional`}
					onChange={(event) => form.setValue("apiKey", event.target.value)}
				/>
				{form.formState.errors.apiKey?.message !== undefined && (
					<p role="alert" className="text-xs text-danger">
						{form.formState.errors.apiKey.message}
					</p>
				)}
			</div>
			{existing?.hasApiKey === true && (
				<CheckboxField control={form.control} name="removeKey" label={t`Remove the stored key`} />
			)}
			<CheckboxField control={form.control} name="enabled" label={t`Enabled`} />
		</FormDialog>
	);
}
