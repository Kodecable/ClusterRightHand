import type { ExtensionConfigField, ExtensionConfigView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** What the administrator typed: text for strings, numbers and secrets, a flag for booleans. */
export type SettingsDraft = Record<string, string | boolean>;

/** The draft a built-in's settings start from: the stored plain values, and empty secrets (never returned). */
export function initialSettings(config: ExtensionConfigView | null): SettingsDraft {
	const draft: SettingsDraft = {};
	for (const field of config?.fields ?? []) {
		const stored = config?.values[field.key];
		if (field.kind === "boolean") draft[field.key] = typeof stored === "boolean" ? stored : field.default === true;
		else if (field.kind === "secret") draft[field.key] = "";
		else draft[field.key] = stored === undefined ? "" : String(stored);
	}
	return draft;
}

/**
 * The settings to send: only what changed. An empty plain field removes the value so the default applies; an
 * empty secret keeps the stored one unless it is marked for removal.
 */
export function settingsChanges(
	config: ExtensionConfigView | null,
	draft: SettingsDraft,
	cleared: readonly string[],
): Record<string, string | number | boolean | null> | undefined {
	const changes: Record<string, string | number | boolean | null> = {};
	for (const field of config?.fields ?? []) {
		const value = draft[field.key];
		const stored = config?.values[field.key];
		if (field.kind === "secret") {
			if (typeof value === "string" && value !== "") changes[field.key] = value;
			else if (cleared.includes(field.key)) changes[field.key] = null;
		} else if (field.kind === "boolean") {
			const before = typeof stored === "boolean" ? stored : field.default === true;
			if (value !== before) changes[field.key] = value === true;
		} else {
			const text = typeof value === "string" ? value.trim() : "";
			if (text === (stored === undefined ? "" : String(stored))) continue;
			changes[field.key] = text === "" ? null : field.kind === "number" ? Number(text) : text;
		}
	}
	return Object.keys(changes).length === 0 ? undefined : changes;
}

/** The label and help of a setting in the interface language; the server's English text otherwise. */
function useFieldText(extension: string, field: ExtensionConfigField): { label: string; description: string } {
	const { t } = useLingui();
	if (extension === "crhs-ds-search" && field.key === "apiKey") {
		return {
			label: t`API key`,
			description: t`A DeepSeek API key; Search and Fetch are billed to its account per successful request.`,
		};
	}
	if (extension === "crhs-ds-search" && field.key === "baseUrl") {
		return { label: t`Base URL`, description: t`The DeepSeek API base URL.` };
	}
	return { label: field.label, description: field.description };
}

function SettingField({
	extension,
	field,
	config,
	draft,
	cleared,
	onChange,
	onClear,
}: {
	extension: string;
	field: ExtensionConfigField;
	config: ExtensionConfigView;
	draft: SettingsDraft;
	cleared: readonly string[];
	onChange: (key: string, value: string | boolean) => void;
	onClear: (key: string, clear: boolean) => void;
}) {
	const { t } = useLingui();
	const text = useFieldText(extension, field);
	const id = `extension-setting-${field.key}`;
	const value = draft[field.key];
	if (field.kind === "boolean") {
		return (
			<label htmlFor={id} className="flex items-center gap-2 text-sm">
				<Checkbox
					id={id}
					checked={value === true}
					onCheckedChange={(checked) => onChange(field.key, Boolean(checked))}
				/>
				{text.label}
			</label>
		);
	}
	const set = field.kind === "secret" && config.secretsSet.includes(field.key);
	return (
		<div className="grid gap-1.5">
			<Label htmlFor={id}>
				{text.label}
				{field.required && <span className="text-muted-foreground"> *</span>}
			</Label>
			<Input
				id={id}
				type={field.kind === "secret" ? "password" : field.kind === "number" ? "number" : "text"}
				autoComplete="off"
				value={typeof value === "string" ? value : ""}
				placeholder={
					field.kind === "secret"
						? set
							? t`Set; leave empty to keep it`
							: ""
						: field.default === null
							? ""
							: String(field.default)
				}
				disabled={cleared.includes(field.key)}
				onChange={(event) => onChange(field.key, event.target.value)}
			/>
			<p className="text-xs text-muted-foreground">{text.description}</p>
			{set && (
				<label htmlFor={`${id}-clear`} className="flex items-center gap-2 text-xs">
					<Checkbox
						id={`${id}-clear`}
						checked={cleared.includes(field.key)}
						onCheckedChange={(checked) => onClear(field.key, Boolean(checked))}
					/>
					<Trans>Remove the stored value</Trans>
				</label>
			)}
		</div>
	);
}

/** A built-in extension's settings, such as an API key; secrets are write-only. */
export function BuiltinSettings({
	extension,
	config,
	draft,
	cleared,
	onChange,
	onClear,
}: {
	extension: string;
	config: ExtensionConfigView;
	draft: SettingsDraft;
	cleared: readonly string[];
	onChange: (key: string, value: string | boolean) => void;
	onClear: (key: string, clear: boolean) => void;
}) {
	const { t } = useLingui();
	return (
		<fieldset className="grid gap-3">
			<legend className="text-sm font-medium">{t`Settings`}</legend>
			{config.missing.length > 0 && (
				<p className="text-xs text-muted-foreground">
					<Trans>The settings marked * are required before the extension can be enabled.</Trans>
				</p>
			)}
			{config.fields.map((field) => (
				<SettingField
					key={field.key}
					extension={extension}
					field={field}
					config={config}
					draft={draft}
					cleared={cleared}
					onChange={onChange}
					onClear={onClear}
				/>
			))}
		</fieldset>
	);
}
