import { Link, useNavigate } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";
import { cn, linkClass } from "@/lib/utils";

type LinkText = {
	children?: ReactNode;
	className?: string;
	title?: string;
	"aria-label"?: string;
};

/**
 * A link to a validated internal path (the `href` form) or to a typed route (the `to` form). The href form
 * is the one server-provided paths use: the path is only rendered when `safeInternalPath` accepted it; a
 * normal click goes through the router (modifier clicks keep the browser's new-tab behaviour).
 */
export type InternalLinkProps = LinkText & ({ href: string | undefined } | RouteTarget);

/** A route target, typed loosely so one component serves every page (the router checks the route at runtime). */
export type RouteTarget = {
	to: string;
	params?: Record<string, string | undefined>;
	search?: Record<string, unknown>;
};

export function InternalLink(props: InternalLinkProps) {
	const navigate = useNavigate();
	const { children, className, title, "aria-label": ariaLabel } = props;
	if ("to" in props) {
		const { to, params, search } = props;
		return (
			<Link
				to={to as never}
				params={params as never}
				search={search as never}
				title={title}
				aria-label={ariaLabel}
				className={cn(linkClass, className)}
			>
				{children}
			</Link>
		);
	}
	const { href } = props;
	if (href === undefined) return null;
	const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		void navigate({ href });
	};
	return (
		<a href={href} onClick={onClick} title={title} aria-label={ariaLabel} className={cn(linkClass, className)}>
			{children}
		</a>
	);
}
