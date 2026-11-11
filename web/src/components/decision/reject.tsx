import { Trans } from "@lingui/react/macro";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The one Reject tab of a rule approval and a signature wait (doc/design/webui.md "Shared components"):
 * an optional reason and the destructive decision. The caller runs the
 * matching endpoint; this form owns only the text.
 */
export function RejectDecision({ busy = false, onReject }: { busy?: boolean; onReject: (reason: string) => void }) {
	const id = useId();
	const [reason, setReason] = useState("");
	return (
		<div className="grid min-w-0 gap-2" data-testid="decision-reject">
			<label className="grid gap-1 text-xs font-medium" htmlFor={id}>
				<Trans>Reason (optional)</Trans>
				<Textarea
					id={id}
					rows={2}
					maxLength={1000}
					value={reason}
					disabled={busy}
					onChange={(event) => setReason(event.target.value)}
				/>
			</label>
			<div className="flex justify-end">
				<Button type="button" variant="destructive" disabled={busy} onClick={() => onReject(reason.trim())}>
					<Trans>Reject</Trans>
				</Button>
			</div>
		</div>
	);
}
