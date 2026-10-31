import { zodResolver } from "@hookform/resolvers/zod";
import type { I18n } from "@lingui/core";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useId, useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { ErrorText } from "@/components/error-state";
import { CheckboxField, FieldShell, TextareaField, TextField } from "@/components/form";
import { ModelSelect } from "@/components/model-select";
import { PresetSelect } from "@/components/preset-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced";
import type { AvailableModel, ModelRef, Preset } from "@/lib/api/types";
import { formatDateTimeSeconds } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSchedulePreview } from "./api";
import {
	defaultTimezone,
	type ParsedSchedule,
	parseScheduleForm,
	presetNoteText,
	type ScheduleFormErrorCode,
	type ScheduleFormErrors,
	type ScheduleFormState,
	scheduleFormErrorText,
} from "./scheduleForm";

const TIMEZONES = [
	"UTC",
	"Europe/Berlin",
	"Europe/London",
	"Asia/Shanghai",
	"Asia/Tokyo",
	"America/New_York",
	"America/Chicago",
	"America/Los_Angeles",
	"Australia/Sydney",
];

/** The initial form values for a new schedule or an existing one. */
export function scheduleFormStateOf(schedule?: {
	name: string;
	prompt: string;
	model: ModelRef;
	preset: Preset | null;
	tokenBudget: number | null;
	cron: string;
	timezone: string;
	catchUp: boolean;
	enabled: boolean;
}): ScheduleFormState {
	return {
		name: schedule?.name ?? "",
		prompt: schedule?.prompt ?? "",
		model: schedule?.model,
		preset: schedule?.preset ?? "ask",
		tokenBudget:
			schedule?.tokenBudget === null || schedule?.tokenBudget === undefined ? "" : String(schedule.tokenBudget),
		cron: schedule?.cron ?? "0 9 * * *",
		timezone: schedule?.timezone ?? defaultTimezone(),
		catchUp: schedule?.catchUp ?? false,
		enabled: schedule?.enabled ?? true,
	};
}

/**
 * The form's schema reuses the pure validator so the page, the component tests
 * and the server agree on what a valid schedule is; only the message text is
 * translated here.
 */
function buildSchema(i18n: I18n) {
	return z
		.object({
			name: z.string(),
			prompt: z.string(),
			model: z.custom<ModelRef | undefined>(),
			preset: z.enum(["ask", "auto_review", "yolo"]),
			tokenBudget: z.string(),
			cron: z.string(),
			timezone: z.string(),
			catchUp: z.boolean(),
			enabled: z.boolean(),
		})
		.superRefine((values, context) => {
			const parsed = parseScheduleForm(values);
			if (!("errors" in parsed)) return;
			for (const [field, code] of Object.entries(parsed.errors)) {
				context.addIssue({
					code: "custom",
					path: [field],
					message: scheduleFormErrorText(i18n, code as ScheduleFormErrorCode),
				});
			}
		});
}

/**
 * The form shared by "New schedule" and the detail page (doc/scheduling.md
 * "形态"): name, prompt, model, preset, budget, the cron and timezone with a
 * live preview, catch-up and enabled.
 */
export function ScheduleForm({
	initial,
	models,
	submitLabel,
	busy = false,
	error,
	onSubmit,
	children,
}: {
	initial: ScheduleFormState;
	models: AvailableModel[];
	submitLabel: ReactNode;
	busy?: boolean;
	error?: unknown;
	onSubmit: (input: ParsedSchedule) => void;
	children?: ReactNode;
}) {
	const { t, i18n } = useLingui();
	const { locale } = useLocale();
	const prefix = useId();
	const id = (key: string) => `${prefix}-${key}`;
	const schema = useMemo(() => buildSchema(i18n), [i18n]);

	const form = useForm<ScheduleFormState>({
		resolver: zodResolver(schema),
		defaultValues: initial,
	});
	const preset = useWatch({ control: form.control, name: "preset" });
	const cron = useWatch({ control: form.control, name: "cron" });
	const timezone = useWatch({ control: form.control, name: "timezone" });
	const debouncedCron = useDebouncedValue(cron.trim(), 300);
	const debouncedTimezone = useDebouncedValue(timezone.trim(), 300);
	const preview = useSchedulePreview(debouncedCron, debouncedTimezone);

	const submit = form.handleSubmit((values) => {
		const parsed = parseScheduleForm(values);
		if ("input" in parsed) onSubmit(parsed.input);
	});

	const fieldError = (field: keyof ScheduleFormErrors | "preset"): string | undefined => {
		const code = form.formState.errors[field]?.message;
		return typeof code === "string" ? code : undefined;
	};

	return (
		<form onSubmit={submit} className="grid gap-3" noValidate data-testid="schedule-form">
			<TextField
				control={form.control}
				name="name"
				label={t`Name`}
				placeholder={t`Nightly check`}
				description={t`Shown in the schedule list; at most 200 characters.`}
			/>
			<TextareaField
				control={form.control}
				name="prompt"
				label={t`Prompt`}
				rows={5}
				placeholder={t`What the new session should do`}
				description={t`Every run starts a fresh session with this prompt.`}
			/>
			<div className="grid gap-3 sm:grid-cols-2">
				<FieldShell
					id={id("model")}
					label={t`Model`}
					error={fieldError("model")}
					description={t`The model every new session of this schedule uses.`}
				>
					<Controller
						control={form.control}
						name="model"
						render={({ field }) => (
							<ModelSelect
								id={id("model")}
								models={models}
								value={field.value}
								onChange={(model) => field.onChange(model)}
							/>
						)}
					/>
				</FieldShell>
				<FieldShell id={id("preset")} label={t`Preset`} error={fieldError("preset")}>
					<Controller
						control={form.control}
						name="preset"
						render={({ field }) => (
							<PresetSelect id={id("preset")} value={field.value} onChange={(next) => field.onChange(next)} />
						)}
					/>
				</FieldShell>
			</div>
			<p className={preset === "yolo" ? "text-sm text-warn" : "text-sm text-muted-foreground"}>
				{presetNoteText(i18n, preset)}
			</p>

			<FieldShell
				id={id("tokenBudget")}
				label={t`Token budget`}
				error={fieldError("tokenBudget")}
				description={t`Counts model output tokens, not input. Empty means unlimited.`}
			>
				<Input
					id={id("tokenBudget")}
					inputMode="numeric"
					placeholder={t`unlimited`}
					{...form.register("tokenBudget")}
				/>
			</FieldShell>

			<div className="grid gap-3 sm:grid-cols-2">
				<TextField
					control={form.control}
					name="cron"
					label={t`Cron`}
					placeholder="*/5 * * * *"
					description={t`Five fields: minute hour day-of-month month day-of-week, in the chosen IANA timezone.`}
				/>
				<FieldShell
					id={id("timezone")}
					label={t`Timezone`}
					error={fieldError("timezone")}
					description={t`Defaults to this browser's timezone.`}
				>
					<Input id={id("timezone")} list={`${prefix}-timezones`} {...form.register("timezone")} />
					<datalist id={`${prefix}-timezones`}>
						{TIMEZONES.map((tz) => (
							<option key={tz} value={tz} />
						))}
					</datalist>
				</FieldShell>
			</div>

			<div role="status" aria-label={t`Next runs`} className="min-h-5 text-sm">
				{preview.isError ? (
					<ErrorText error={preview.error} />
				) : preview.data ? (
					preview.data.length === 0 ? (
						<span className="text-muted-foreground">{t`No upcoming runs.`}</span>
					) : (
						<span className="text-muted-foreground">
							<Plural value={preview.data.length} one="Next run:" other="Next runs:" />{" "}
							{preview.data.map((time) => formatDateTimeSeconds(time, locale)).join(", ")}
						</span>
					)
				) : (
					<span className="text-muted-foreground">{t`Next runs: –`}</span>
				)}
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				<CheckboxField
					control={form.control}
					name="catchUp"
					label={t`Catch up a missed trigger after downtime`}
					description={t`Runs once when crhs starts again if a trigger was missed while it was down.`}
				/>
				<CheckboxField control={form.control} name="enabled" label={t`Enabled`} />
			</div>

			<ErrorText error={error} />
			{Object.keys(form.formState.errors).length > 0 && (
				<p role="alert" className="text-sm text-danger">
					<Trans>Check the highlighted fields.</Trans>
				</p>
			)}
			<div className="flex flex-wrap items-center justify-end gap-2">
				{children}
				<Button type="submit" disabled={busy}>
					{submitLabel}
				</Button>
			</div>
		</form>
	);
}
