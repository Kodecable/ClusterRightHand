import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import {
	type AvailableModel,
	api,
	type ModelRef,
	type Preset,
	type ScheduleInput,
	type ScheduleRunView,
	type ScheduleView,
} from "../api.ts";
import { Badge, ErrorText, Loading } from "../components/Feedback.tsx";
import { Modal } from "../components/Modal.tsx";
import { ModelSelect } from "../components/ModelSelect.tsx";
import { errMsg, useAction, useLoad, usePolling } from "../hooks.ts";
import { formatTime } from "../lib.ts";
import { navigate } from "../router.ts";
import {
	defaultTimezone,
	parseScheduleForm,
	presetNote,
	runNote,
	type ScheduleFormErrors,
	type ScheduleFormState,
	scheduleState,
	stateBadgeKind,
} from "../scheduleForm.ts";

/** The initial form values for a new schedule or an existing one. */
function formStateOf(schedule?: ScheduleView): ScheduleFormState {
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

/** The form shared by "New schedule" and the detail page (doc/scheduling.md#形态). */
function ScheduleEditor({
	initial,
	models,
	submitLabel,
	busy,
	error,
	onSubmit,
	children,
}: {
	initial: ScheduleFormState;
	models: AvailableModel[];
	submitLabel: string;
	busy: boolean;
	error: string | undefined;
	onSubmit: (input: ScheduleInput) => void;
	children?: ReactNode;
}) {
	const [state, setState] = useState(initial);
	const [errors, setErrors] = useState<ScheduleFormErrors>({});
	const [preview, setPreview] = useState<string[]>([]);
	const [previewError, setPreviewError] = useState<string>();
	// Ask the server for the next few fire times, so the cron can be checked before saving.
	useEffect(() => {
		const cron = state.cron.trim();
		const timezone = state.timezone.trim();
		if (!cron || !timezone) {
			setPreview([]);
			setPreviewError(undefined);
			return;
		}
		const timer = setTimeout(() => {
			api.previewSchedule(cron, timezone, 5).then(
				(times) => {
					setPreview(times);
					setPreviewError(undefined);
				},
				(e: unknown) => {
					setPreview([]);
					setPreviewError(errMsg(e));
				},
			);
		}, 300);
		return () => clearTimeout(timer);
	}, [state.cron, state.timezone]);
	const set = <K extends keyof ScheduleFormState>(key: K, value: ScheduleFormState[K]) =>
		setState((current) => ({ ...current, [key]: value }));
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const parsed = parseScheduleForm(state);
		if ("errors" in parsed) {
			setErrors(parsed.errors);
			return;
		}
		setErrors({});
		onSubmit(parsed.input);
	};
	const formError =
		errors.name ?? errors.prompt ?? errors.model ?? errors.tokenBudget ?? errors.cron ?? errors.timezone ?? error;
	return (
		<form onSubmit={submit} className="stack">
			<label>
				Name
				<input value={state.name} onChange={(e) => set("name", e.target.value)} maxLength={200} />
			</label>
			<label>
				Prompt
				<textarea
					value={state.prompt}
					onChange={(e) => set("prompt", e.target.value)}
					rows={5}
					placeholder="What the new session should do"
				/>
			</label>
			<div className="row wrap">
				<ModelSelect models={models} value={state.model} onChange={(m: ModelRef) => set("model", m)} />
				<label>
					Preset
					<select value={state.preset} onChange={(e) => set("preset", e.target.value as Preset)}>
						<option value="ask">Ask</option>
						<option value="auto_review">Auto Review</option>
						<option value="yolo">Yolo</option>
					</select>
				</label>
			</div>
			<p className={state.preset === "yolo" ? "warn" : "muted"}>{presetNote(state.preset)}</p>
			<label>
				Token budget (empty = unlimited, at least 1)
				<input
					inputMode="numeric"
					value={state.tokenBudget}
					onChange={(e) => set("tokenBudget", e.target.value)}
					placeholder="unlimited"
				/>
				<span className="muted">counts model output tokens, not input</span>
			</label>
			<div className="row wrap">
				<label>
					Cron
					<input
						className="mono"
						value={state.cron}
						onChange={(e) => set("cron", e.target.value)}
						placeholder="*/5 * * * *"
					/>
				</label>
				<label>
					Timezone
					<input
						value={state.timezone}
						onChange={(e) => set("timezone", e.target.value)}
						list="schedule-timezones"
						placeholder="Europe/Berlin"
					/>
					<datalist id="schedule-timezones">
						{TIMEZONES.map((tz) => (
							<option key={tz} value={tz} />
						))}
					</datalist>
				</label>
			</div>
			<p className="muted">Five fields: minute hour day-of-month month day-of-week, in the chosen IANA timezone.</p>
			{previewError ? (
				<ErrorText error={previewError} />
			) : (
				<p className="muted" role="status" aria-label="Next runs">
					{preview.length > 0 ? `Next runs: ${preview.map((t) => formatTime(t)).join(", ")}` : "Next runs: -"}
				</p>
			)}
			<div className="row wrap">
				<label className="row">
					<input type="checkbox" checked={state.catchUp} onChange={(e) => set("catchUp", e.target.checked)} />
					Catch up a missed trigger after downtime
				</label>
				<label className="row">
					<input type="checkbox" checked={state.enabled} onChange={(e) => set("enabled", e.target.checked)} />
					Enabled
				</label>
			</div>
			<ErrorText error={formError} />
			<div className="row end">
				{children}
				<button type="submit" className="primary" disabled={busy}>
					{submitLabel}
				</button>
			</div>
		</form>
	);
}

/** "Run now", with the confirmation the docs require when an instance is in progress. */
function RunNow({ schedule, onChange }: { schedule: ScheduleView; onChange: () => void }) {
	const [confirm, setConfirm] = useState(false);
	const { busy, error, run } = useAction();
	const start = async () => {
		if (await run(() => api.runSchedule(schedule.id))) {
			setConfirm(false);
			onChange();
		}
	};
	return (
		<>
			<button type="button" disabled={busy} onClick={() => (schedule.inProgress ? setConfirm(true) : void start())}>
				Run now
			</button>
			{confirm && (
				<Modal title={`Run ${schedule.name} now?`} onClose={() => setConfirm(false)}>
					<p>This stops the current run. Its history will show it as preempted.</p>
					<ErrorText error={error} />
					<div className="row end">
						<button type="button" onClick={() => setConfirm(false)}>
							Cancel
						</button>
						<button type="button" className="danger" disabled={busy} onClick={start}>
							Stop it and run now
						</button>
					</div>
				</Modal>
			)}
		</>
	);
}

function Toggle({ schedule, onChange }: { schedule: ScheduleView; onChange: () => void }) {
	const { busy, error, run } = useAction();
	const toggle = async () => {
		if (await run(() => api.patchSchedule(schedule.id, { enabled: !schedule.enabled }))) onChange();
	};
	return (
		<>
			<label className="row">
				<input
					type="checkbox"
					checked={schedule.enabled}
					disabled={busy}
					aria-label={`Enabled ${schedule.name}`}
					onChange={toggle}
				/>
				{schedule.enabled ? "enabled" : "disabled"}
			</label>
			<ErrorText error={error} />
		</>
	);
}

/** The run history, newest first, with the session each run created (doc/scheduling.md#调度). */
function RunHistory({ scheduleId, inProgress }: { scheduleId: string; inProgress: boolean }) {
	const [runs, setRuns] = useState<ScheduleRunView[]>([]);
	const [nextOffset, setNextOffset] = useState<number | null>(null);
	const [error, setError] = useState<string>();
	const loadFirst = useCallback(() => {
		api.listScheduleRuns(scheduleId, { limit: 20 }).then(
			(page) => {
				setRuns(page.runs);
				setNextOffset(page.nextOffset);
				setError(undefined);
			},
			(e: unknown) => setError(errMsg(e)),
		);
	}, [scheduleId]);
	useEffect(loadFirst, [loadFirst]);
	// While a run is in progress the page follows it; otherwise only actions and the refresh button fetch.
	usePolling(() => {
		if (inProgress) loadFirst();
	}, 2_000);
	const older = async () => {
		if (nextOffset === null) return;
		try {
			const page = await api.listScheduleRuns(scheduleId, { limit: 20, offset: nextOffset });
			setRuns((current) => [...current, ...page.runs]);
			setNextOffset(page.nextOffset);
		} catch (e) {
			setError(errMsg(e));
		}
	};
	return (
		<section className="stack">
			<div className="row">
				<h2>Run history</h2>
				<span className="spacer" />
				<button type="button" onClick={loadFirst}>
					Refresh
				</button>
			</div>
			<ErrorText error={error} />
			{runs.length === 0 ? (
				<p className="muted">No runs yet.</p>
			) : (
				<div className="scroll-x">
					<table aria-label="Schedule runs">
						<thead>
							<tr>
								<th>Triggered for</th>
								<th>Status</th>
								<th>When</th>
								<th>Session</th>
								<th>Note</th>
							</tr>
						</thead>
						<tbody>
							{runs.map((run) => (
								<tr key={run.id}>
									<td>{formatTime(run.fireTime)}</td>
									<td>
										<Badge kind={stateBadgeKind(run.status)}>{run.status}</Badge>
									</td>
									<td>{formatTime(run.finishedAt ?? run.startedAt ?? run.createdAt)}</td>
									<td>
										{run.sessionId ? (
											<a href={`#/sessions/${encodeURIComponent(run.sessionId)}`}>{run.sessionId.slice(0, 8)}</a>
										) : (
											"-"
										)}
									</td>
									<td>
										{runNote(run)}
										{run.manual && <span className="muted"> · manual</span>}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{nextOffset !== null && (
				<div className="row">
					<button type="button" onClick={older}>
						Load older runs
					</button>
				</div>
			)}
		</section>
	);
}

function CreateSchedule({ models, onClose }: { models: AvailableModel[]; onClose: () => void }) {
	const { busy, error, run } = useAction();
	const submit = async (input: ScheduleInput) => {
		const schedule = await run(() => api.createSchedule(input));
		if (schedule) navigate(`/schedules/${schedule.id}`);
	};
	return (
		<Modal title="New schedule" onClose={onClose}>
			<ScheduleEditor
				initial={formStateOf()}
				models={models}
				submitLabel="Create schedule"
				busy={busy}
				error={error}
				onSubmit={submit}
			/>
		</Modal>
	);
}

function ScheduleRow({ schedule, onChanged }: { schedule: ScheduleView; onChanged: () => void }) {
	const state = scheduleState(schedule);
	return (
		<tr>
			<td>
				<a href={`#/schedules/${encodeURIComponent(schedule.id)}`}>{schedule.name}</a>
			</td>
			<td>
				<code className="mono">{schedule.cron}</code>
				<div className="muted">{schedule.timezone}</div>
			</td>
			<td>{schedule.enabled ? formatTime(schedule.nextRunAt) : <Badge kind="off">disabled</Badge>}</td>
			<td>
				<Badge kind={stateBadgeKind(state)}>{state}</Badge>
			</td>
			<td>
				<Toggle schedule={schedule} onChange={onChanged} />
			</td>
			<td className="actions">
				<RunNow schedule={schedule} onChange={onChanged} />
			</td>
		</tr>
	);
}

export function Schedules() {
	const { data, error, loading, reload } = useLoad(() => api.listSchedules(), []);
	const models = useLoad(() => api.listModels(), []);
	const [creating, setCreating] = useState(false);
	// Keep the enabled toggles and the "Run now" confirmation current.
	usePolling(reload, 5_000);
	const noModels = models.data !== undefined && models.data.length === 0;
	return (
		<>
			<h1>Schedules</h1>
			<p className="muted">
				A schedule creates a new session at each trigger and submits a fixed prompt. Every run acts for its owner
				through the same rules, approvals and limits as any other session.
			</p>
			<div className="row">
				<button type="button" className="primary" onClick={() => setCreating(true)} disabled={!models.data?.length}>
					New schedule
				</button>
			</div>
			{noModels && (
				<p className="warn" role="status">
					No models are configured, so schedules cannot run.
				</p>
			)}
			<ErrorText error={models.error} />
			<Loading loading={loading && !data} error={error} />
			{data && data.length === 0 && <p className="muted">No schedules yet.</p>}
			{data && data.length > 0 && (
				<div className="scroll-x">
					<table aria-label="Schedules">
						<thead>
							<tr>
								<th>Name</th>
								<th>Cron</th>
								<th>Next run</th>
								<th>Last result</th>
								<th>Enabled</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{data.map((schedule) => (
								<ScheduleRow key={schedule.id} schedule={schedule} onChanged={reload} />
							))}
						</tbody>
					</table>
				</div>
			)}
			{creating && models.data && <CreateSchedule models={models.data} onClose={() => setCreating(false)} />}
		</>
	);
}

/** The schedule's form plus its history and the privilege note (doc/scheduling.md#提权). */
export function ScheduleDetail({ id }: { id: string }) {
	const schedule = useLoad(() => api.getSchedule(id), [id]);
	const models = useLoad(() => api.listModels(), [id]);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [historyKey, setHistoryKey] = useState(0);
	const save = useAction();
	const remove = useAction();
	usePolling(schedule.reload, 3_000);
	if (schedule.error) return <ErrorText error={schedule.error} />;
	if (!schedule.data) return <Loading loading={schedule.loading} />;
	const current = schedule.data;
	const update = async (input: ScheduleInput) => {
		if (await save.run(() => api.patchSchedule(id, input))) {
			schedule.reload();
		}
	};
	const destroy = async () => {
		if (await remove.run(() => api.deleteSchedule(id))) navigate("/schedules");
	};
	return (
		<>
			<div className="row">
				<h1>{current.name}</h1>
				<span className="spacer" />
				<RunNow
					schedule={current}
					onChange={() => {
						schedule.reload();
						setHistoryKey((key) => key + 1);
					}}
				/>
				<button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
					Delete
				</button>
			</div>
			<p className="muted">
				Last result: <Badge kind={stateBadgeKind(scheduleState(current))}>{scheduleState(current)}</Badge>
				{current.lastRun?.reason ? ` · ${current.lastRun.reason}` : ""}
			</p>
			{models.data && (
				<ScheduleEditor
					key={current.id}
					initial={formStateOf(current)}
					models={models.data}
					submitLabel="Save schedule"
					busy={save.busy}
					error={save.error}
					onSubmit={update}
				/>
			)}
			<RunHistory key={historyKey} scheduleId={id} inProgress={current.inProgress} />
			<section className="stack">
				<h2>Privileges</h2>
				<p className="muted">
					A scheduled run uses the normal authorization path: privileged tasks wait for the owner's signature. To let a
					fixed command run unattended, issue a reusable authorization for it (no task ids) on the{" "}
					<a href="#/authorizations">Authorizations</a> page, and have the prompt run exactly that command. Anything
					else still waits in Approvals, and the next trigger ends the run.
				</p>
			</section>
			{confirmDelete && (
				<Modal title={`Delete ${current.name}?`} onClose={() => setConfirmDelete(false)}>
					<p>
						The running instance, if any, is stopped, and the run history is deleted. Sessions the runs created stay,
						without their schedule.
					</p>
					<ErrorText error={remove.error} />
					<div className="row end">
						<button type="button" onClick={() => setConfirmDelete(false)}>
							Cancel
						</button>
						<button type="button" className="danger" disabled={remove.busy} onClick={destroy}>
							Delete schedule
						</button>
					</div>
				</Modal>
			)}
		</>
	);
}
