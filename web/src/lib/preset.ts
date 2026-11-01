import type { Preset } from "@/lib/api/types";

/**
 * The rule presets in menu order, under the product names the UI shows: the
 * raw server values (`ask`, `auto_review`, `yolo`) never reach a label, so a
 * session header, a token row and a picker always agree (doc/webui.md
 * "Preset"). The explanation of each preset belongs next to the form, not here.
 */
export const PRESETS: readonly { value: Preset; label: string }[] = [
	{ value: "ask", label: "Ask" },
	{ value: "auto_review", label: "Auto Review" },
	{ value: "yolo", label: "Yolo" },
];

/** The display name of a preset, or "" when there is none (a token without rules). */
export function presetLabel(preset: string | null | undefined): string {
	return PRESETS.find((entry) => entry.value === preset)?.label ?? "";
}
