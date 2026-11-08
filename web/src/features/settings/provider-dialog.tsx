import { zodResolver } from "@hookform/resolvers/zod";
import type { I18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { type ComponentProps, useEffect, useMemo, useState } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormDialog } from "@/components/dialogs";
import { CheckboxField, SelectField, TextField } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ModelProviderInput, ModelProviderView } from "@/lib/api/types";
import { useSaveModelProvider } from "./api";
import { ModelDialog } from "./model-dialog";
import {
	emptyModelRow,
	type HeaderRow,
	type ModelRow,
	modelToRow,
	normalizeBaseUrl,
	PROVIDER_ID_PATTERN,
	providerErrorText,
	rowsToHeaders,
	rowsToModels,
	rowsToSessionId,
	type SessionIdRow,
} from "./providers";

interface ProviderValues {
	kind: "builtin" | "custom";
	providerId: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	removeKey: boolean;
	enabled: boolean;
	headers: HeaderRow[];
	sessionHeaders: SessionIdRow[];
	sessionBody: SessionIdRow[];
	models: ModelRow[];
}

type ProviderForm = ReturnType<typeof useForm<ProviderValues>>;

/** The text cells of the header and session id rows. */
type RowPath =
	| `headers.${number}.name`
	| `headers.${number}.value`
	| `sessionHeaders.${number}.value`
	| `sessionBody.${number}.value`;

/**
 * One row cell bound through a `Controller`: a keystroke re-renders this input
 * only, not the whole provider form.
 */
function RowInput({
	control,
	name,
	...props
}: { control: ProviderForm["control"]; name: RowPath } & Omit<
	ComponentProps<typeof Input>,
	"name" | "value" | "onChange"
>) {
	return (
		<Controller
			control={control}
			name={name}
			render={({ field }) => <Input {...props} ref={field.ref} value={field.value} onChange={field.onChange} />}
		/>
	);
}

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
		headers: Object.entries(provider?.headers ?? {}).map(([name, value]) => ({ name, value })),
		sessionHeaders: (provider?.sessionId?.headers ?? []).map((value) => ({ value })),
		sessionBody: (provider?.sessionId?.body ?? []).map((value) => ({ value })),
		models: (provider?.models ?? []).map((model) => modelToRow(model)),
	};
}

function buildSchema(
	i18n: I18n,
	original: { baseUrl: string | null; hasStoredKey: boolean } = { baseUrl: null, hasStoredKey: false },
) {
	const message = (code: Parameters<typeof providerErrorText>[1]) => providerErrorText(i18n, code);
	return z
		.object({
			kind: z.enum(["builtin", "custom"]),
			providerId: z.string(),
			name: z.string(),
			baseUrl: z.string(),
			apiKey: z.string(),
			removeKey: z.boolean(),
			enabled: z.boolean(),
			headers: z.array(z.object({ name: z.string(), value: z.string() })),
			sessionHeaders: z.array(z.object({ value: z.string() })),
			sessionBody: z.array(z.object({ value: z.string() })),
			// The model rows are validated by `rowsToModels` below; a per-row schema would only
			// duplicate the conversion and lose the field-level errors the model sheet shows.
			models: z.custom<ModelRow[]>((value) => Array.isArray(value)),
		})
		.superRefine((values, context) => {
			if (!PROVIDER_ID_PATTERN.test(values.providerId)) {
				context.addIssue({
					code: "custom",
					path: ["providerId"],
					message: message("provider-id-invalid"),
				});
			}
			if (values.kind !== "custom") return;
			const baseUrl = values.baseUrl.trim();
			if (baseUrl === "") {
				context.addIssue({ code: "custom", path: ["baseUrl"], message: message("base-url-required") });
			} else if (!/^https?:\/\//.test(baseUrl)) {
				context.addIssue({ code: "custom", path: ["baseUrl"], message: message("base-url-invalid") });
			}
			// A new endpoint would receive the stored key: the server refuses it, so ask for the key here.
			if (
				original.hasStoredKey &&
				!values.removeKey &&
				normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(original.baseUrl) &&
				values.apiKey.trim() === ""
			) {
				context.addIssue({ code: "custom", path: ["apiKey"], message: message("api-key-required") });
			}
			const models = rowsToModels(values.models);
			if ("error" in models) {
				context.addIssue({ code: "custom", path: ["models"], message: message(models.error) });
			}
		});
}

/** A compact summary of a model's thinking configuration for the provider table. */
function ThinkingSummary({ row }: { row: ModelRow }) {
	const { t } = useLingui();
	if (row.thinkingMode === "none") return <span>{t`None`}</span>;
	if (row.thinkingMode === "standard") {
		return (
			<span className="flex items-center gap-1">
				<span>{t`Standard`}</span>
				<code className="font-mono text-xs">{row.format || t`auto`}</code>
			</span>
		);
	}
	return <span>{t`Custom`}</span>;
}

/** The custom provider's extra request headers, one key/value row each. */
function HeadersEditor({ form }: { form: ProviderForm }) {
	const { t } = useLingui();
	const { fields, append, remove } = useFieldArray({ control: form.control, name: "headers" });
	return (
		<fieldset className="grid gap-2">
			<legend className="text-sm font-medium">{t`Extra headers`}</legend>
			<p className="text-xs text-muted-foreground">
				<Trans>
					Headers are stored and shown in plaintext, not as secrets. Do not put API keys or Authorization tokens here;
					use the API key field.
				</Trans>
			</p>
			{fields.length > 0 && (
				<div className="grid gap-2">
					<div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs text-muted-foreground">
						<span>{t`Header`}</span>
						<span>{t`Value`}</span>
						<span />
					</div>
					{fields.map((field, index) => (
						<div key={field.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
							<RowInput
								aria-label={t`Header ${index + 1} name`}
								control={form.control}
								name={`headers.${index}.name`}
							/>
							<RowInput
								aria-label={t`Header ${index + 1} value`}
								control={form.control}
								name={`headers.${index}.value`}
							/>
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								aria-label={t`Remove header ${index + 1}`}
								onClick={() => remove(index)}
							>
								<Trash2Icon />
							</Button>
						</div>
					))}
				</div>
			)}
			<div>
				<Button type="button" size="sm" variant="outline" onClick={() => append({ name: "", value: "" })}>
					<PlusIcon />
					<Trans>Add header</Trans>
				</Button>
			</div>
		</fieldset>
	);
}

/** Request header names and request body dot paths that receive the crh session id. */
function SessionIdEditor({ form }: { form: ProviderForm }) {
	const { t } = useLingui();
	const headers = useFieldArray({ control: form.control, name: "sessionHeaders" });
	const body = useFieldArray({ control: form.control, name: "sessionBody" });
	return (
		<fieldset className="grid gap-2">
			<legend className="text-sm font-medium">{t`Session id fields`}</legend>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="grid content-start gap-2">
					<span className="text-xs text-muted-foreground">{t`Headers`}</span>
					{headers.fields.map((field, index) => (
						<div key={field.id} className="flex gap-2">
							<RowInput
								aria-label={t`Session id header ${index + 1}`}
								placeholder="x-opencode-session"
								control={form.control}
								name={`sessionHeaders.${index}.value`}
							/>
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								aria-label={t`Remove session id header ${index + 1}`}
								onClick={() => headers.remove(index)}
							>
								<Trash2Icon />
							</Button>
						</div>
					))}
					<div>
						<Button type="button" size="sm" variant="outline" onClick={() => headers.append({ value: "" })}>
							<PlusIcon />
							<Trans>Add header</Trans>
						</Button>
					</div>
				</div>
				<div className="grid content-start gap-2">
					<span className="text-xs text-muted-foreground">{t`Body fields`}</span>
					{body.fields.map((field, index) => (
						<div key={field.id} className="flex gap-2">
							<RowInput
								aria-label={t`Session id body field ${index + 1}`}
								placeholder="metadata.session_id"
								control={form.control}
								name={`sessionBody.${index}.value`}
							/>
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								aria-label={t`Remove session id body field ${index + 1}`}
								onClick={() => body.remove(index)}
							>
								<Trash2Icon />
							</Button>
						</div>
					))}
					<div>
						<Button type="button" size="sm" variant="outline" onClick={() => body.append({ value: "" })}>
							<PlusIcon />
							<Trans>Add field</Trans>
						</Button>
					</div>
				</div>
			</div>
		</fieldset>
	);
}

/** The custom provider's models: a compact table whose rows open the nested model dialog. */
function ModelRows({ form }: { form: ProviderForm }) {
	const { t } = useLingui();
	const { fields, append, remove, update } = useFieldArray({ control: form.control, name: "models" });
	const models = form.watch("models");
	const [editing, setEditing] = useState<number | "new">();
	return (
		<fieldset className="grid gap-2">
			<legend className="text-sm font-medium">{t`Models`}</legend>
			<div className="overflow-auto rounded-lg border">
				<Table aria-label={t`Models`}>
					<TableHeader>
						<TableRow>
							<TableHead>{t`Id`}</TableHead>
							<TableHead>{t`Protocol`}</TableHead>
							<TableHead>{t`Context window`}</TableHead>
							<TableHead>{t`Max output`}</TableHead>
							<TableHead>{t`Image`}</TableHead>
							<TableHead>{t`Thinking`}</TableHead>
							<TableHead className="w-32" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{fields.map((field, index) => {
							const row = models[index] ?? emptyModelRow();
							return (
								<TableRow key={field.id}>
									<TableCell>
										<code className="font-mono text-xs">{row.id || "–"}</code>
									</TableCell>
									<TableCell className="text-xs">
										{row.api === "openai-completions" ? t`Chat Completions` : t`Responses`}
									</TableCell>
									<TableCell className="text-xs">{row.contextWindow}</TableCell>
									<TableCell className="text-xs">{row.maxTokens}</TableCell>
									<TableCell className="text-xs">{row.imageUnderstanding ? t`Yes` : t`No`}</TableCell>
									<TableCell className="text-xs">
										<ThinkingSummary row={row} />
									</TableCell>
									<TableCell>
										<span className="flex flex-nowrap items-center gap-1">
											<Button
												type="button"
												size="xs"
												variant="outline"
												aria-label={t`Edit model ${index + 1}`}
												onClick={() => setEditing(index)}
											>
												<Trans>Edit</Trans>
											</Button>
											<Button
												type="button"
												size="icon-xs"
												variant="ghost"
												aria-label={t`Remove model ${index + 1}`}
												onClick={() => remove(index)}
											>
												<Trash2Icon />
											</Button>
										</span>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
			<div>
				<Button type="button" size="sm" variant="outline" onClick={() => setEditing("new")}>
					<PlusIcon />
					<Trans>Add model</Trans>
				</Button>
			</div>
			{form.formState.errors.models?.message !== undefined && (
				<p role="alert" className="text-xs text-danger">
					{form.formState.errors.models.message}
				</p>
			)}
			{editing !== undefined && (
				<ModelDialog
					editing={editing !== "new"}
					initial={editing === "new" ? emptyModelRow() : (models[editing] ?? emptyModelRow())}
					onClose={() => setEditing(undefined)}
					onSave={(model) => {
						if (editing === "new") append(model);
						else update(editing, model);
						setEditing(undefined);
					}}
				/>
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
	const save = useSaveModelProvider();
	const editing = existing !== undefined;
	const originalBaseUrl = existing?.kind === "custom" ? existing.baseUrl : null;
	const hasStoredKey = existing?.kind === "custom" && existing.hasApiKey;
	const schema = useMemo(
		() => buildSchema(i18n, { baseUrl: originalBaseUrl, hasStoredKey }),
		[i18n, originalBaseUrl, hasStoredKey],
	);
	const form = useForm<ProviderValues>({
		resolver: zodResolver(schema),
		defaultValues: providerValues(existing, builtin),
	});
	const kind = form.watch("kind");
	const providerId = form.watch("providerId");
	const baseUrl = form.watch("baseUrl");
	// The server refuses a new endpoint without a new key; the same check here shows why before submitting.
	const baseUrlChanged = editing && hasStoredKey && normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(originalBaseUrl);

	// A new provider starts on the first Pi built-in id; switching back from
	// custom must not leave a custom id that is not in the select's options.
	useEffect(() => {
		if (editing || kind !== "builtin") return;
		if (!builtin.includes(form.getValues("providerId"))) form.setValue("providerId", builtin[0] ?? "");
	}, [editing, kind, builtin, form]);

	const submit = form.handleSubmit((values) => {
		const body: ModelProviderInput = { kind: values.kind, enabled: values.enabled };
		if (values.kind === "builtin") {
			const baseUrl = values.baseUrl.trim();
			body.baseUrl = baseUrl === "" ? null : baseUrl;
		} else {
			const models = rowsToModels(values.models);
			if ("error" in models) return;
			body.name = values.name.trim() || values.providerId;
			body.baseUrl = values.baseUrl.trim();
			body.models = models.models;
			body.headers = rowsToHeaders(values.headers);
			body.sessionId = rowsToSessionId(values.sessionHeaders, values.sessionBody);
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
			submitLabel={<Trans>Save provider</Trans>}
			busy={save.isPending}
			submitDisabled={providerId === ""}
			error={save.error !== null ? save.error.message : undefined}
			testId="provider-dialog"
			className="sm:max-w-3xl"
			onSubmit={() => void submit()}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<SelectField
					control={form.control}
					name="kind"
					label={t`Kind`}
					disabled={editing}
					options={[
						{ value: "builtin", label: t`Pi built-in` },
						{ value: "custom", label: t`Custom` },
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

			{kind === "builtin" ? (
				<TextField
					control={form.control}
					name="baseUrl"
					type="url"
					label={t`Base URL`}
					placeholder="https://api.example.com/v1"
					description={t`Optional, overrides the provider's default endpoint.`}
				/>
			) : (
				<div className="grid gap-3 sm:grid-cols-2">
					<TextField control={form.control} name="name" label={t`Name`} />
					<TextField
						control={form.control}
						name="baseUrl"
						type="url"
						label={t`Base URL`}
						placeholder="https://api.example.com/v1"
					/>
				</div>
			)}

			<TextField
				control={form.control}
				name="apiKey"
				type="password"
				autoComplete="off"
				label={t`API key`}
				disabled={form.watch("removeKey")}
				description={
					baseUrlChanged ? <Trans>Changing the base URL requires re-entering the API key.</Trans> : undefined
				}
				placeholder={
					baseUrlChanged
						? t`Required for the new base URL`
						: existing?.hasApiKey
							? t`Leave empty to keep the current key`
							: t`Optional`
				}
			/>
			{existing?.hasApiKey === true && (
				<CheckboxField control={form.control} name="removeKey" label={t`Remove the stored key`} />
			)}
			<CheckboxField control={form.control} name="enabled" label={t`Enabled`} />

			{kind === "custom" && (
				<>
					<HeadersEditor form={form} />
					<SessionIdEditor form={form} />
					<ModelRows form={form} />
				</>
			)}
		</FormDialog>
	);
}
