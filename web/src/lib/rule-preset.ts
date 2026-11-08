import type { RulePreset } from "@crh/api";
import { type LucideIcon, ShieldAlertIcon, ShieldEllipsisIcon, ShieldQuestionMarkIcon } from "lucide-react";

/**
 * The rule presets in menu order, under the product names the UI shows: the
 * raw server values (`ask`, `auto_review`, `yolo`) never reach a label, so a
 * session header, a token row and a picker always agree (doc/webui.md
 * "输入框页脚"). Each rule preset carries its icon, so the composer footer's
 * rules control shows the same symbol as the picker. The explanation of each
 * rule preset belongs next to the form, not here.
 */
export const RULE_PRESETS: readonly { value: RulePreset; label: string; icon: LucideIcon }[] = [
	{ value: "ask", label: "Ask", icon: ShieldQuestionMarkIcon },
	{ value: "auto_review", label: "Auto Review", icon: ShieldEllipsisIcon },
	{ value: "yolo", label: "Yolo", icon: ShieldAlertIcon },
];

/** The display name of a rule preset, or "" when there is none (a token without rules). */
export function rulePresetLabel(rulePreset: string | null | undefined): string {
	return RULE_PRESETS.find((entry) => entry.value === rulePreset)?.label ?? "";
}

/** The icon of a rule preset, for the controls that show the name beside it. */
export function rulePresetIcon(rulePreset: string | null | undefined): LucideIcon | undefined {
	return RULE_PRESETS.find((entry) => entry.value === rulePreset)?.icon;
}
