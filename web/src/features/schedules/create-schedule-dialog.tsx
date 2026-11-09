import type { AvailableModel } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogScrollArea, DialogTitle } from "@/components/ui/dialog";
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
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						<Trans>New schedule</Trans>
					</DialogTitle>
				</DialogHeader>
				<DialogScrollArea className="max-h-[70vh]">
					<ScheduleForm
						initial={initial}
						models={models}
						submitLabel={t`New schedule`}
						busy={create.isPending}
						error={create.error}
						onSubmit={(input) => {
							create.mutate(input, {
								onSuccess: (schedule) => {
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
