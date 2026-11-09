import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes, letting later classes win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

/**
 * The one inline-link style (doc/webui.md "链接"): foreground text with a thin
 * underline. A link never uses the primary colour, which would read as a
 * button; the underline thickens on hover as the only hover affordance.
 */
export const linkClass = "text-foreground underline underline-offset-2 hover:decoration-2";
