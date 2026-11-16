import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn, externalLinkClass } from "@/lib/utils";

/**
 * A link to another site (doc/design/webui.md "List navigation, links and refresh"): brand-coloured, with
 * the same faint underline that becomes solid on hover, and a small arrow after the text. It always opens in
 * a new tab, without an opener reference.
 */
export function ExternalLink({
	href,
	children,
	className,
	title,
	dataLink,
}: {
	href: string;
	children?: ReactNode;
	className?: string;
	title?: string;
	/** The markdown renderer's `data-link="allowed"` marker. */
	dataLink?: string;
}) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			title={title}
			data-link={dataLink}
			className={cn(externalLinkClass, className)}
		>
			{children}
			<ArrowUpRight aria-hidden="true" className="ml-0.5 inline size-3 align-baseline" />
		</a>
	);
}
