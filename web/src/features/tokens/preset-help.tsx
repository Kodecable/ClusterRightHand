import { Trans } from "@lingui/react/macro";
import type { Preset } from "@/lib/api/types";

/** The explanation of a preset, shown under the picker where it is chosen. */
export function PresetHelp({ preset }: { preset: Preset }) {
	switch (preset) {
		case "ask":
			return (
				<Trans>
					Ask: ordinary reads run, everything else (including every privileged task) waits for your approval.
				</Trans>
			);
		case "auto_review":
			return (
				<Trans>
					Auto Review: approvals first go to the review model; anything risky still waits for your approval.
				</Trans>
			);
		case "yolo":
			return <Trans>Yolo: everything runs without asking.</Trans>;
	}
}
