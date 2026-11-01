import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { PageSkeleton } from "@/components/skeletons";
import { ScheduleStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useModels } from "@/features/settings/api";
import type { AvailableModel, ScheduleRunView, ScheduleView } from "@/lib/api/types";
import {
	useCreateSchedule,
	useDeleteSchedule,
	usePatchSchedule,
	useRunSchedule,
	useSchedule,
	useScheduleRuns,
	useSchedules,
} from "./api";
import { ScheduleForm, scheduleFormStateOf } from "./schedule-form";
import { runNoteParts, runStatusText, type ScheduleFormState, scheduleState } from "./scheduleForm";

/** "Run now", with the confirmation the docs require when an instance is in progress. */
function RunNowButton({ schedule }: { schedule: ScheduleView }) {
	const { t } = useLingui();
	const run = useRunSchedule();
	const [confirm, setConfirm] = useState(false);
	const start = () => {
		run.mutate(schedule.id, {
			onSuccess: () => {
				toast.success(t`Run started.`);
				setConfirm(false);
			},
			onError: (error) => toast.error(error.message),
		});
	};
	return (
		<>
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={run.isPending}
				onClick={() => (schedule.inProgress ? setConfirm(true) : start())}
			>
				<Trans>Run now</Trans>
			</Button>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title={t`Run ${schedule.name} now?`}
				description={<Trans>This stops the current run. Its history will show it as preempted.</Trans>}
				confirmLabel={<Trans>Stop it and run now</Trans>}
				busy={run.isPending}
				onConfirm={start}
			/>
		</>
	);
}

/** The enabled toggle of one schedule; it patches and toasts on failure. */
function EnabledSwitch({ schedule }: { schedule: ScheduleView }) {
	const { t } = useLingui();
	const patch = usePatchSchedule(schedule.id);
	return (
		<Switch
			checked={schedule.enabled}
			disabled={patch.isPending}
			aria-label={t`Enabled: ${schedule.name}`}
			onCheckedChange={(checked) => {
				patch.mutate({ enabled: Boolean(checked) }, { onError: (error) => toast.error(error.message) });
			}}
		/>
	);
}

function RunHistory({ scheduleId, inProgress }: { scheduleId: string; inProgress: boolean }) {
	const { t, i18n } = useLingui();
	const runs = useScheduleRuns(scheduleId, 20, inProgress ? 2_000 : false);
	const rows = useMemo(() => runs.data?.pages.flatMap((page) => page.items) ?? [], [runs.data]);

	const columns = useMemo<DataTableColumn<ScheduleRunView>[]>(
		() => [
			{
				id: "fireTime",
				header: t`Triggered for`,
				size: 170,
				cell: ({ row }) => <DateTime value={row.original.fireTime} seconds />,
			},
			{
				id: "status",
				header: t`Status`,
				size: 120,
				cell: ({ row }) => <ScheduleStatusBadge status={row.original.status} />,
			},
			{
				id: "when",
				header: t`When`,
				size: 170,
				cell: ({ row }) => (
					<DateTime value={row.original.finishedAt ?? row.original.startedAt ?? row.original.createdAt} seconds />
				),
			},
			{
				id: "session",
				header: t`Session`,
				size: 110,
				cell: ({ row }) =>
					row.original.sessionId === null ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<Link
							to="/sessions/$sessionId"
							params={{ sessionId: row.original.sessionId }}
							className="font-mono text-xs text-primary underline underline-offset-2"
						>
							{row.original.sessionId.slice(0, 8)}
						</Link>
					),
			},
			{
				id: "note",
				header: t`Note`,
				cell: ({ row }) => {
					const { status, reason, manual } = runNoteParts(row.original);
					return (
						<span className="text-xs">
							{reason ?? runStatusText(i18n, status)}
							{manual && (
								<span className="text-muted-foreground">
									{" · "}
									<Trans>run by hand</Trans>
								</span>
							)}
						</span>
					);
				},
			},
		],
		[i18n, t],
	);

	return (
		<section className="grid gap-2" aria-labelledby="schedule-runs-heading" data-testid="schedule-runs">
			<div className="flex items-center justify-between gap-2">
				<h2 id="schedule-runs-heading" className="text-sm font-semibold">
					<Trans>Run history</Trans>
				</h2>
				<Button type="button" variant="outline" size="sm" onClick={() => void runs.refetch()}>
					<Trans>Refresh</Trans>
				</Button>
			</div>
			<DataTable
				label={t`Schedule runs`}
				columns={columns}
				data={rows}
				getRowId={(run) => run.id}
				loading={runs.isLoading}
				error={runs.isError ? runs.error : undefined}
				onRetry={() => void runs.refetch()}
				hasMore={runs.hasNextPage}
				loadingMore={runs.isFetchingNextPage}
				onLoadMore={() => void runs.fetchNextPage()}
				empty={
					<EmptyState
						title={<Trans>No runs yet</Trans>}
						description={<Trans>This schedule has not fired yet.</Trans>}
					/>
				}
			/>
		</section>
	);
}

function CreateScheduleDialog({ models, onClose }: { models: AvailableModel[]; onClose: () => void }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const create = useCreateSchedule();
	const initial = useMemo<ScheduleFormState>(() => scheduleFormStateOf(), []);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>New schedule</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>A schedule creates a new session at every trigger and submits a fixed prompt.</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="max-h-[70vh] overflow-auto pr-1">
					<ScheduleForm
						initial={initial}
						models={models}
						submitLabel={t`Create schedule`}
						busy={create.isPending}
						error={create.error}
						onSubmit={(input) => {
							create.mutate(input, {
								onSuccess: (schedule) => {
									toast.success(t`Schedule created.`);
									onClose();
									void navigate({ to: "/schedules/$scheduleId", params: { scheduleId: schedule.id } });
								},
								onError: (error) => toast.error(error.message),
							});
						}}
					>
						<Button type="button" variant="outline" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
					</ScheduleForm>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Every schedule the user owns (doc/scheduling.md "调度"): next run, last
 * result and the two inline actions. Editing happens on the detail page; the
 * list refreshes so runs started elsewhere show up.
 */
export function SchedulesPage() {
	const { t } = useLingui();
	const schedules = useSchedules();
	const models = useModels();
	const [creating, setCreating] = useState(false);
	const rows = useMemo(() => schedules.data ?? [], [schedules.data]);
	const noModels = models.data !== undefined && models.data.length === 0;

	const columns = useMemo<DataTableColumn<ScheduleView>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				cell: ({ row }) => (
					<Link
						to="/schedules/$scheduleId"
						params={{ scheduleId: row.original.id }}
						className="truncate font-medium text-primary underline underline-offset-2"
					>
						{row.original.name}
					</Link>
				),
			},
			{
				id: "cron",
				header: t`Cron`,
				size: 200,
				cell: ({ row }) => (
					<div className="min-w-0">
						<code className="font-mono text-xs">{row.original.cron}</code>
						<p className="truncate text-xs text-muted-foreground">{row.original.timezone}</p>
						{/* A row saved before the zone was validated still lists; its preview is empty and
						    the server says why (doc/scheduling.md#调度). */}
						{row.original.previewError !== null && (
							<p data-testid="schedule-preview-error" className="text-xs text-danger">
								{row.original.previewError}
							</p>
						)}
					</div>
				),
			},
			{
				id: "next",
				header: t`Next run`,
				size: 180,
				cell: ({ row }) =>
					!row.original.enabled ? (
						<Badge variant="secondary">
							<Trans>Disabled</Trans>
						</Badge>
					) : (
						<DateTime value={row.original.nextRunAt} />
					),
			},
			{
				id: "last",
				header: t`Last result`,
				size: 130,
				cell: ({ row }) => <ScheduleStatusBadge status={scheduleState(row.original)} />,
			},
			{
				id: "enabled",
				header: t`Enabled`,
				size: 96,
				cell: ({ row }) => <EnabledSwitch schedule={row.original} />,
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 130,
				cell: ({ row }) => <RunNowButton schedule={row.original} />,
			},
		],
		[t],
	);

	return (
		<Page data-testid="schedules-page">
			<PageHeader
				title={<Trans>Schedules</Trans>}
				description={
					<Trans>
						A schedule creates a new session at each trigger and submits a fixed prompt. Every run acts for its owner
						through the same rules, approvals and limits as any other session.
					</Trans>
				}
				actions={
					<Button
						type="button"
						disabled={!models.data?.length}
						onClick={() => setCreating(true)}
						data-testid="new-schedule"
					>
						<PlusIcon />
						<Trans>New schedule</Trans>
					</Button>
				}
			/>
			{noModels && (
				<p role="status" className="rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
					<Trans>No models are configured, so schedules cannot run.</Trans>
				</p>
			)}
			{models.isError && <ErrorState error={models.error} compact />}
			<DataTable
				label={t`Schedules`}
				columns={columns}
				data={rows}
				getRowId={(schedule) => schedule.id}
				loading={schedules.isLoading}
				error={schedules.isError ? schedules.error : undefined}
				onRetry={() => void schedules.refetch()}
				empty={
					<EmptyState
						title={<Trans>No schedules yet</Trans>}
						description={<Trans>Create a schedule to run a fixed prompt on a cron expression.</Trans>}
					/>
				}
			/>
			{creating && models.data && <CreateScheduleDialog models={models.data} onClose={() => setCreating(false)} />}
		</Page>
	);
}

/** The schedule's form plus its history and the privilege note (doc/scheduling.md "提权"). */
export function ScheduleDetailPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { scheduleId?: string };
	const id = params.scheduleId ?? "";
	const schedule = useSchedule(id);
	const models = useModels();
	const patch = usePatchSchedule(id);
	const remove = useDeleteSchedule();
	const navigate = useNavigate();
	const [confirmDelete, setConfirmDelete] = useState(false);

	if (schedule.isError) {
		return (
			<div className="p-4">
				<ErrorState error={schedule.error} retry={() => void schedule.refetch()} />
			</div>
		);
	}
	if (!schedule.data || !models.data) {
		return (
			<div className="p-4">
				<PageSkeleton />
			</div>
		);
	}

	const current = schedule.data;

	return (
		<Page width="detail" data-testid="schedule-detail">
			<div>
				<Link
					to="/schedules"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All schedules</Trans>
				</Link>
			</div>
			<PageHeader
				title={current.name}
				description={
					<span className="flex flex-wrap items-center gap-2">
						<Trans>Last result:</Trans>
						<ScheduleStatusBadge status={scheduleState(current)} />
						{current.lastRun?.reason !== null && current.lastRun?.reason !== undefined && (
							<span className="text-xs">{current.lastRun.reason}</span>
						)}
					</span>
				}
				actions={
					<>
						<RunNowButton schedule={current} />
						<Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
							<Trash2Icon />
							<Trans>Delete</Trans>
						</Button>
					</>
				}
			/>
			<section className="rounded-lg border p-4" aria-label={t`Schedule form`}>
				<ScheduleForm
					key={current.id}
					initial={scheduleFormStateOf(current)}
					models={models.data}
					submitLabel={t`Save schedule`}
					busy={patch.isPending}
					error={patch.error}
					onSubmit={(input) => {
						patch.mutate(input, {
							onSuccess: () => toast.success(t`Schedule saved.`),
							onError: (error) => toast.error(error.message),
						});
					}}
				/>
			</section>
			<RunHistory scheduleId={id} inProgress={current.inProgress} />
			<section className="grid gap-2" aria-labelledby="schedule-privileges-heading">
				<h2 id="schedule-privileges-heading" className="text-sm font-semibold">
					<Trans>Privileges</Trans>
				</h2>
				<p className="max-w-3xl text-sm text-muted-foreground">
					<Trans>
						A scheduled run uses the normal authorization path: privileged tasks wait for the owner's signature. To let
						a fixed command run unattended, issue a reusable authorization for it (no task ids) on the
					</Trans>{" "}
					<Link to="/authorizations" className="text-primary underline underline-offset-2">
						<Trans>Authorizations</Trans>
					</Link>{" "}
					<Trans>
						page, and have the prompt run exactly that command. Anything else still waits in Approvals, and the next
						trigger ends the run.
					</Trans>
				</p>
			</section>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={t`Delete ${current.name}?`}
				description={
					<Trans>
						The running instance, if any, is stopped, and the run history is deleted. Sessions the runs created stay,
						without their schedule.
					</Trans>
				}
				confirmLabel={<Trans>Delete schedule</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					remove.mutate(id, {
						onSuccess: () => {
							toast.success(t`Schedule deleted.`);
							void navigate({ to: "/schedules" });
						},
						onError: (error) => toast.error(error.message),
					});
				}}
			/>
		</Page>
	);
}
