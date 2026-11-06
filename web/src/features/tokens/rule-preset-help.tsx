import { Trans } from "@lingui/react/macro";
import type { RulePreset } from "@/lib/api/types";

/** The explanation of a rule preset, shown under the picker where it is chosen. */
export function RulePresetHelp({ rulePreset }: { rulePreset: RulePreset }) {
	switch (rulePreset) {
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
