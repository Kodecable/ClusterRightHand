import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";
import { cn, linkClass } from "@/lib/utils";

/**
 * A link to a server-provided internal path. The path is only rendered when
 * `safeInternalPath` accepted it; a normal click goes through the router
 * (modifier clicks keep the browser's new-tab behaviour).
 */
export function InternalLink({
	href,
	children,
	className,
}: {
	/** Already validated with `safeInternalPath`; undefined renders nothing. */
	href: string | undefined;
	children?: ReactNode;
	className?: string;
}) {
	const navigate = useNavigate();
	if (href === undefined) return null;
	const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		void navigate({ href });
	};
	return (
		<a href={href} onClick={onClick} className={cn(linkClass, className)}>
			{children}
		</a>
	);
}
