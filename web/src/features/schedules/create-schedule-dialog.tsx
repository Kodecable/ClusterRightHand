import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogScrollArea,
	DialogTitle,
} from "@/components/ui/dialog";
import type { AvailableModel } from "@/lib/api/types";
import { useCreateSchedule } from "./api";
import { ScheduleForm, scheduleFormStateOf } from "./schedule-form";
import type { ScheduleFormState } from "./scheduleForm";

/** The "New schedule" dialog: the shared schedule form in a dialog, with the new schedule opened after. */
export function CreateScheduleDialog({ models, onClose }: { models: AvailableModel[]; onClose: () => void }) {
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
				<DialogScrollArea className="max-h-[70vh]">
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
							});
						}}
					>
						<Button type="button" variant="outline" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
					</ScheduleForm>
				</DialogScrollArea>
			</DialogContent>
		</Dialog>
	);
}
