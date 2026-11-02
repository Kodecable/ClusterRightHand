import { type LucideIcon, ShieldAlertIcon, ShieldEllipsisIcon, ShieldQuestionMarkIcon } from "lucide-react";
import type { Preset } from "@/lib/api/types";

/**
 * The rule presets in menu order, under the product names the UI shows: the
 * raw server values (`ask`, `auto_review`, `yolo`) never reach a label, so a
 * session header, a token row and a picker always agree (doc/webui.md
 * "Preset"). Each preset carries its icon, so the composer footer's rules
 * control shows the same symbol as the picker. The explanation of each preset
 * belongs next to the form, not here.
 */
export const PRESETS: readonly { value: Preset; label: string; icon: LucideIcon }[] = [
	{ value: "ask", label: "Ask", icon: ShieldQuestionMarkIcon },
	{ value: "auto_review", label: "Auto Review", icon: ShieldEllipsisIcon },
	{ value: "yolo", label: "Yolo", icon: ShieldAlertIcon },
];

/** The display name of a preset, or "" when there is none (a token without rules). */
export function presetLabel(preset: string | null | undefined): string {
	return PRESETS.find((entry) => entry.value === preset)?.label ?? "";
}

/** The icon of a preset, for the controls that show the name beside it. */
export function presetIcon(preset: string | null | undefined): LucideIcon | undefined {
	return PRESETS.find((entry) => entry.value === preset)?.icon;
}
