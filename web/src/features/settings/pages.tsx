import { zodResolver } from "@hookform/resolvers/zod";
import type { I18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { CheckboxField, SelectField, TextareaField, TextField } from "@/components/form";
import { modelKey, parseModelKey } from "@/components/model-select";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ModelProviderInput, ModelProviderView, ModelRef } from "@/lib/api/types";
import {
	useDeleteModelProvider,
	useModelProviders,
	useModels,
	useReviewModel,
	useSaveModelProvider,
	useSetReviewModel,
} from "./api";
import { type ModelRow, PROVIDER_ID_PATTERN, parseHeaders, providerErrorText, rowsToModels } from "./providers";

const NONE = "__session__";

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
				onError: (error) => toast.error(error.message),
			},
		);
	});

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-2xl" data-testid="provider-dialog">
				<DialogHeader>
					<DialogTitle>{editing ? t`Edit provider ${existing.providerId}` : t`Add model provider`}</DialogTitle>
					<DialogDescription>
						<Trans>Sessions use the models of the enabled providers.</Trans>
					</DialogDescription>
				</DialogHeader>
				<form className="grid gap-3" onSubmit={(event) => void submit(event)} noValidate>
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
					{save.error !== null && (
						<p role="alert" className="text-sm text-danger">
							{save.error.message}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={save.isPending || form.watch("providerId") === ""}>
							<Trans>Save provider</Trans>
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function ReviewModelCard() {
	const { t } = useLingui();
	const models = useModels();
	const review = useReviewModel();
	const save = useSetReviewModel();
	const [value, setValue] = useState<string>(NONE);

	useEffect(() => {
		if (review.data === undefined) return;
		setValue(review.data === null ? NONE : modelKey(review.data));
	}, [review.data]);

	return (
		<section
			className="grid gap-2 rounded-lg border p-4"
			aria-labelledby="review-model-heading"
			data-testid="review-model"
		>
			<h2 id="review-model-heading" className="text-sm font-semibold">
				<Trans>Review model</Trans>
			</h2>
			<p className="text-sm text-muted-foreground">
				<Trans>
					Auto Review sends approvals it cannot decide to this model. Without one, each session's own model is used.
				</Trans>
			</p>
			<div className="flex flex-wrap items-end gap-2">
				<div className="grid min-w-64 gap-1.5">
					<Label htmlFor="review-model-select">{t`Model`}</Label>
					<Select value={value} onValueChange={(next) => setValue(String(next))}>
						<SelectTrigger id="review-model-select" className="w-full">
							<SelectValue>
								{(current: string | null) => {
									if (current === null || current === NONE) return t`Each session's own model`;
									const model = models.data?.find((candidate) => modelKey(candidate) === current);
									return model?.name ?? current;
								}}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NONE}>{t`Each session's own model`}</SelectItem>
							{(models.data ?? []).map((model) => (
								<SelectItem key={modelKey(model)} value={modelKey(model)}>
									{model.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<Button
					type="button"
					variant="outline"
					disabled={save.isPending || review.data === undefined}
					onClick={() => {
						const model: ModelRef | null = value === NONE ? null : parseModelKey(value);
						save.mutate(model, {
							onSuccess: () => toast.success(t`Review model saved.`),
							onError: (error) => toast.error(error.message),
						});
					}}
				>
					<Trans>Save</Trans>
				</Button>
			</div>
			{save.error !== null && (
				<p role="alert" className="text-sm text-danger">
					{save.error.message}
				</p>
			)}
		</section>
	);
}

/**
 * Model providers (administrators only, doc/webui.md "Models"): builtin
 * providers and OpenAI-compatible endpoints, their keys (never displayed
 * back), and the model Auto Review uses.
 */
export function ModelSettingsPage() {
	const { t } = useLingui();
	const providers = useModelProviders();
	const remove = useDeleteModelProvider();
	const [editing, setEditing] = useState<ModelProviderView | "new">();
	const [deleting, setDeleting] = useState<ModelProviderView>();

	const columns = useMemo<DataTableColumn<ModelProviderView>[]>(
		() => [
			{
				id: "id",
				header: t`Id`,
				size: 150,
				cell: ({ row }) => <code className="font-mono text-xs">{row.original.providerId}</code>,
			},
			{
				id: "kind",
				header: t`Kind`,
				size: 160,
				cell: ({ row }) => (
					<span className="text-xs">{row.original.kind === "builtin" ? t`Built-in` : t`OpenAI-compatible`}</span>
				),
			},
			{
				id: "name",
				header: t`Name`,
				cell: ({ row }) => <span className="truncate text-xs">{row.original.name}</span>,
			},
			{
				id: "baseUrl",
				header: t`Base URL`,
				size: 200,
				cell: ({ row }) => <span className="truncate font-mono text-xs">{row.original.baseUrl ?? "–"}</span>,
			},
			{
				id: "key",
				header: t`API key`,
				size: 100,
				cell: ({ row }) =>
					row.original.hasApiKey ? (
						<Badge variant="secondary">
							<Trans>set</Trans>
						</Badge>
					) : (
						<span className="text-xs text-muted-foreground">
							<Trans>not set</Trans>
						</span>
					),
			},
			{
				id: "enabled",
				header: t`Status`,
				size: 100,
				cell: ({ row }) =>
					row.original.enabled ? (
						<Badge variant="secondary">
							<Trans>enabled</Trans>
						</Badge>
					) : (
						<span className="text-xs text-muted-foreground">
							<Trans>disabled</Trans>
						</span>
					),
			},
			{
				id: "models",
				header: t`Models`,
				cell: ({ row }) => (
					<span className="truncate text-xs">
						{row.original.models ? row.original.models.map((model) => model.id).join(", ") : t`all built-in models`}
					</span>
				),
			},
			{
				id: "actions",
				header: "",
				size: 150,
				cell: ({ row }) => (
					<span className="flex flex-wrap gap-1">
						<Button
							type="button"
							size="xs"
							variant="outline"
							aria-label={t`Edit ${row.original.providerId}`}
							onClick={() => setEditing(row.original)}
						>
							<Trans>Edit</Trans>
						</Button>
						<Button
							type="button"
							size="xs"
							variant="destructive"
							aria-label={t`Delete ${row.original.providerId}`}
							onClick={() => setDeleting(row.original)}
						>
							<Trash2Icon />
							<Trans>Delete</Trans>
						</Button>
					</span>
				),
			},
		],
		[t],
	);

	return (
		<div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4" data-testid="models-page">
			<PageHeader
				title={<Trans>Model providers</Trans>}
				description={<Trans>Sessions use the models of the enabled providers below.</Trans>}
				actions={
					<Button type="button" onClick={() => setEditing("new")} data-testid="add-provider">
						<PlusIcon />
						<Trans>Add provider</Trans>
					</Button>
				}
			/>
			<ReviewModelCard />
			<DataTable
				label={t`Model providers`}
				columns={columns}
				data={providers.data?.providers ?? []}
				getRowId={(provider) => provider.id}
				loading={providers.isLoading}
				error={providers.isError ? providers.error : undefined}
				onRetry={() => void providers.refetch()}
				empty={
					<EmptyState
						title={<Trans>No model providers yet</Trans>}
						description={<Trans>Add a built-in provider or an OpenAI-compatible endpoint.</Trans>}
					/>
				}
			/>
			{editing !== undefined && providers.data && (
				<ProviderDialog
					existing={editing === "new" ? undefined : editing}
					builtin={providers.data.builtin}
					onClose={() => setEditing(undefined)}
					onSaved={() => void providers.refetch()}
				/>
			)}
			<ConfirmDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleting(undefined);
				}}
				title={deleting ? t`Delete provider ${deleting.providerId}?` : ""}
				description={
					<Trans>
						Its models disappear from the model lists, and its stored key is deleted. Existing sessions that use them
						stop working until you change their model.
					</Trans>
				}
				confirmLabel={<Trans>Delete provider</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.providerId, {
						onSuccess: () => {
							toast.success(t`Provider deleted.`);
							setDeleting(undefined);
						},
						onError: (error) => toast.error(error.message),
					});
				}}
			/>
		</div>
	);
}
