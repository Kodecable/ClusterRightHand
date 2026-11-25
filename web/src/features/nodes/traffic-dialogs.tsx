import { TRAFFIC_PERIOD_MS } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { ConfirmDialog, FormDialog } from "@/components/dialogs";
import { ErrorState, ErrorText } from "@/components/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { localDateTimeToIso, localDateTimeValue, zoneLabel } from "@/lib/timezone";
import { useResetNodeTraffic, useSetNodeTrafficNextReset } from "./api";

/**
 * "Reset now" (doc/design/webui.md "Node pages"): the totals go to zero and a new 30-day period starts
 * now. The confirmation says both, because there is no undo.
 */
export function TrafficResetDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
	const { t } = useLingui();
	const reset = useResetNodeTraffic(nodeId);
	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`Reset traffic now?`}
			description={<Trans>Received and transmitted totals go to zero, and a new 30-day period starts now.</Trans>}
			confirmLabel={<Trans>Reset now</Trans>}
			busy={reset.isPending}
			onConfirm={() => reset.mutate(undefined, { onSuccess: () => onClose() })}
		>
			{reset.error !== null && <ErrorState error={reset.error} compact />}
		</ConfirmDialog>
	);
}

/**
 * "Set next reset" (doc/design/webui.md "Node pages"): the datetime control reads the browser's local
 * time, and the WebUI converts it to the UTC instant the API takes. The label names the zone, so the
 * value is unambiguous; the server keeps the 30-day cycle from the chosen instant.
 */
export function TrafficNextResetDialog({
	nodeId,
	nextResetAt,
	onClose,
}: {
	nodeId: string;
	nextResetAt: string | null;
	onClose: () => void;
}) {
	const { t, i18n } = useLingui();
	const save = useSetNodeTrafficNextReset(nodeId);
	const now = Date.now();
	// Start from the current period's end, or from a fresh 30 days when the node has no period yet.
	const [value, setValue] = useState(() =>
		localDateTimeValue(nextResetAt === null ? now + TRAFFIC_PERIOD_MS : new Date(nextResetAt)),
	);
	const iso = localDateTimeToIso(value);
	const nextMs = iso === undefined ? Number.NaN : Date.parse(iso);
	// The control has no zone of its own, and the label must name the zone the chosen time is read in:
	// across a daylight-saving change that is not the zone of today (doc/design/metrics.md "Traffic totals").
	const chosen = iso === undefined ? new Date(now) : new Date(iso);
	const zone = zoneLabel(i18n.locale, Number.isNaN(chosen.getTime()) ? new Date(now) : chosen);
	// The same bounds the server enforces: in the future and at most 30 days from now.
	const invalid = !(nextMs > now && nextMs <= now + TRAFFIC_PERIOD_MS);
	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`Set next reset`}
			description={
				<Trans>
					The current totals and the period start stay; after this time the normal 30-day cycle continues from it.
				</Trans>
			}
			submitLabel={<Trans>Set next reset</Trans>}
			busy={save.isPending}
			submitDisabled={invalid}
			onSubmit={() => {
				if (iso === undefined) return;
				save.mutate({ nextResetAt: iso }, { onSuccess: () => onClose() });
			}}
			error={save.error === null ? undefined : <ErrorText error={save.error} />}
			testId="traffic-next-reset-dialog"
		>
			<div className="grid gap-1.5">
				<Label htmlFor="traffic-next-reset">
					<Trans>Time ({zone})</Trans>
				</Label>
				<Input
					id="traffic-next-reset"
					type="datetime-local"
					value={value}
					min={localDateTimeValue(now)}
					max={localDateTimeValue(now + TRAFFIC_PERIOD_MS)}
					onChange={(event) => setValue(event.target.value)}
					required
				/>
				<p className="text-xs text-muted-foreground">
					<Trans>Resets every 30 days</Trans>
				</p>
			</div>
		</FormDialog>
	);
}
