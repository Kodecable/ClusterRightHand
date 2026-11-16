import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes, letting later classes win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

/**
 * The one inline-link style (doc/design/webui.md "Links"): foreground text with a faint underline that
 * becomes solid on hover. The thickness never changes; only the decoration colour does, which reads well in
 * both themes. A link never takes the primary colour, which would read as a button.
 */
export const linkClass =
	"text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground";

/** The external-link style: the brand colour with the same faint-to-solid underline. */
export const externalLinkClass =
	"text-primary underline decoration-primary/30 underline-offset-2 transition-colors hover:decoration-primary";

/**
 * A monospace table cell or detail value (doc/design/webui.md "Shared components"): `text-xs` keeps
 * ids, commands and hashes compact, and `leading-5` gives them the same 20px
 * line box as `text-sm`, so a row's mono value centers on the same line as its
 * text neighbours instead of sitting higher.
 */
export const MONO_CELL = "font-mono text-xs leading-5";
