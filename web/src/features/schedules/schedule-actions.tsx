import type { ScheduleView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/dialogs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePatchSchedule, useRunSchedule } from "./api";

/** "Run now", with the confirmation the docs require when an instance is in progress. */
export function RunNowButton({ schedule, size = "sm" }: { schedule: ScheduleView; size?: "xs" | "sm" }) {
	const { t } = useLingui();
	const run = useRunSchedule();
	const [confirm, setConfirm] = useState(false);
	const start = () => {
		run.mutate(schedule.id, {
			onSuccess: () => {
				toast.success(t`Run started.`);
				setConfirm(false);
			},
		});
	};
	return (
		<>
			<Button
				type="button"
				variant="outline"
				size={size}
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
export function EnabledSwitch({ schedule }: { schedule: ScheduleView }) {
	const { t } = useLingui();
	const patch = usePatchSchedule(schedule.id);
	return (
		<Switch
			checked={schedule.enabled}
			disabled={patch.isPending}
			aria-label={t`Enabled: ${schedule.name}`}
			onCheckedChange={(checked) => patch.mutate({ enabled: Boolean(checked) })}
		/>
	);
}
