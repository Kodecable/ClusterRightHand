import { ShortDateTime } from "@/components/relative-time";
import { cn } from "@/lib/utils";

/**
 * The small action row under a user message or a final answer (doc/design/webui.md "Message view"):
 * icon buttons such as Copy and, for the owner on an ended turn, Fork, and the message's time. The row
 * is always shown, in muted colours, so the actions are found without hovering.
 */
export function MessageActions({ children, className }: { children?: React.ReactNode; className?: string }) {
	return (
		<div
			data-testid="message-actions"
			className={cn("flex items-center gap-0.5 pt-0.5 text-muted-foreground", className)}
		>
			{children}
		</div>
	);
}

/**
 * When a message was sent (a user message) or finished (a final answer), in the action row, in the short
 * absolute form of a message stream (doc/design/webui.md "Status, time and task results"). Nothing is
 * shown for a message without a time.
 */
export function MessageTime({ at, className }: { at: number | undefined; className?: string }) {
	if (at === undefined || !Number.isFinite(at)) return null;
	return <ShortDateTime value={at} data-testid="message-time" className={cn("px-1 text-[11px]", className)} />;
}

/** A final answer finishes when its assistant message ends: its start plus how long it took. */
export function replyFinishedAt(item: { at?: number; durationMs?: number }): number | undefined {
	if (item.at === undefined) return undefined;
	return item.durationMs === undefined ? item.at : item.at + item.durationMs;
}
