import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CodeFrameProps extends Omit<ComponentProps<"section">, "title"> {
	/** The header's left side: a language name or a label such as "Standard output". */
	title?: ReactNode;
	/** Optional metadata after the title, e.g. a byte count. */
	meta?: ReactNode;
	/** The header's right side: actions such as copy. */
	actions?: ReactNode;
	/** Extra classes for the body wrapper; use it for the scrollable max height. */
	bodyClassName?: string;
	/** Optional footer bar, e.g. a collapse control. */
	footer?: ReactNode;
	children: ReactNode;
}

/**
 * The one frame around a code block (doc/design/webui.md "Shared components"): a bordered rounded
 * frame with an optional header bar (title, optional meta and actions), a transparent scrollable
 * body and an optional footer bar. The header and footer use the solid muted surface; the body
 * follows the surrounding page, card or dialog surface
 * (doc/design/webui.md "Shell, theme and language").
 */
export function CodeFrame({
	title,
	meta,
	actions,
	bodyClassName,
	footer,
	className,
	children,
	...props
}: CodeFrameProps) {
	const header = title !== undefined || meta !== undefined || actions !== undefined;
	return (
		<section
			data-slot="code-frame"
			className={cn("overflow-hidden rounded-lg border border-border", className)}
			{...props}
		>
			{header && (
				<div
					data-slot="code-frame-header"
					className="flex items-center gap-2 border-b bg-muted px-3 py-1 text-xs text-muted-foreground"
				>
					<div className="flex min-w-0 flex-1 items-baseline">
						{title !== undefined && (
							<span data-slot="code-frame-title" className="min-w-0 truncate font-medium">
								{title}
							</span>
						)}
						{meta !== undefined && (
							<span data-slot="code-frame-meta" className="shrink-0">
								{title !== undefined && " · "}
								{meta}
							</span>
						)}
					</div>
					{actions !== undefined && (
						<div data-slot="code-frame-actions" className="flex shrink-0 items-center gap-1">
							{actions}
						</div>
					)}
				</div>
			)}
			<div data-slot="code-frame-body" className={cn("min-w-0", bodyClassName)}>
				{children}
			</div>
			{footer !== undefined && (
				<div
					data-slot="code-frame-footer"
					className="flex items-center justify-between gap-2 border-t bg-muted px-2 py-1"
				>
					{footer}
				</div>
			)}
		</section>
	);
}
