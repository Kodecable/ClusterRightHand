import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes, letting later classes win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

/**
 * The one inline-link style (doc/design/webui.md "Links"): foreground text with a thin
 * underline. A link never uses the primary colour, which would read as a
 * button; the underline thickens on hover as the only hover affordance.
 */
export const linkClass = "text-foreground underline underline-offset-2 hover:decoration-2";

/**
 * A monospace table cell or detail value (doc/design/webui.md "Tables"): `text-xs` keeps
 * ids, commands and hashes compact, and `leading-5` gives them the same 20px
 * line box as `text-sm`, so a row's mono value centers on the same line as its
 * text neighbours instead of sitting higher.
 */
export const MONO_CELL = "font-mono text-xs leading-5";
