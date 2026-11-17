import { cn } from "@/lib/utils";

/**
 * The small action row under a user message or a final answer (doc/design/webui.md "Message view"):
 * icon buttons such as Copy and, for the owner on an ended turn, Fork. The row stays hidden until the
 * message is hovered or a control in it has keyboard focus; a touch screen has no hover, so it is
 * always shown there. A final answer's row is a row of its own after the delivered files, so the
 * transcript passes `revealed` while the pointer is over the answer's tail.
 */
export function MessageActions({ children, className }: { children?: React.ReactNode; className?: string }) {
	return (
		<div
			data-testid="message-actions"
			className={cn(
				"pointer-events-none flex items-center gap-0.5 pt-0.5 opacity-0 transition-opacity",
				"group-hover/message:pointer-events-auto group-hover/message:opacity-100",
				"group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100",
				"focus-within:pointer-events-auto focus-within:opacity-100",
				"[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
				className,
			)}
		>
			{children}
		</div>
	);
}
