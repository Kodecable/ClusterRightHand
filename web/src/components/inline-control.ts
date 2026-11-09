/**
 * Typography and spacing shared by the composer footer's inline controls (the
 * model, thinking level and rule preset triggers and the budget button).
 *
 * `cn` merges it after the base `SelectTrigger`/`Button` classes, so it wins
 * over their form-field chrome: no `text-sm` or `font-mono`, no `px-2.5`/`px-2`
 * or `py-2`, no `gap-1.5`, and no value gap inside the trigger. The text and
 * icons keep the standard foreground color, so an exhausted budget's
 * `text-danger` has to be merged after this class to win. The trailing chevron
 * is hidden only when it is rendered; the leading icons in the value must stay
 * visible.
 */
export const INLINE_CONTROL_CLASS = [
	"h-6 w-fit min-w-0 shrink justify-start gap-1 rounded-md border-0 bg-transparent px-1.5 py-0 text-xs font-normal text-foreground shadow-none",
	"hover:bg-muted aria-expanded:bg-muted dark:bg-transparent dark:hover:bg-muted",
	"*:data-[slot=select-value]:gap-1",
	// Scope the hiding rule to the trigger's chevron, not the icon in the value.
	"[&>svg.lucide-chevron-down]:hidden",
].join(" ");
