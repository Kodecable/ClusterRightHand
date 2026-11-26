import type { ReactNode } from "react";

/** The row box of a tool-call line: the transcript's left margin, row height, font and muted colour. */
const LINE_CLASSES =
	"group flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

/**
 * One line at the transcript's left edge, shared by a tool call and the running line that ends a live turn
 * (doc/design/webui.md "Message rendering"). Reusing the box is what makes the running line line up with the
 * tool calls above it: same indentation, row height, font, size and colour.
 */
export function TranscriptLine({
	children,
	onClick,
	testId,
}: {
	children: ReactNode;
	onClick?: () => void;
	/** The line's own test id; on a clickable line it sits on the button. */
	testId?: string;
}) {
	return (
		<div className="flex items-center gap-1">
			{onClick === undefined ? (
				<div data-testid={testId} className={LINE_CLASSES}>
					{children}
				</div>
			) : (
				<button type="button" data-testid={testId} aria-haspopup="dialog" onClick={onClick} className={LINE_CLASSES}>
					{children}
				</button>
			)}
		</div>
	);
}
