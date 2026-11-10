import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { inspectUrl } from "@/lib/url";

interface AnchorProps {
	href?: string;
	title?: string;
	className?: string;
	children?: ReactNode;
}

/**
 * Every rendered link goes through here. An unsafe URL never reaches the DOM:
 * the anchor is downgraded to a span, so `a[href]` in the output can only ever
 * be http(s)/mailto (doc/design/webui.md "SafeMarkdown" — security rules).
 */
export function SafeLink({ href, title, className, children }: AnchorProps) {
	const verdict = inspectUrl(href);
	if (!verdict.allowed) {
		return (
			<span className={className} data-blocked-href={typeof href === "string" ? href : ""} data-link="blocked">
				{children}
			</span>
		);
	}
	return (
		<a
			className={className}
			href={verdict.url}
			title={title}
			rel="noopener noreferrer"
			target="_blank"
			data-link="allowed"
		>
			{children}
		</a>
	);
}

interface ImageProps {
	src?: string;
	alt?: string;
	title?: string;
	className?: string;
}

/**
 * Images are never loaded: a remote `<img>` in an agent answer is both a
 * privacy leak (the URL is a beacon) and a tracking vector. Render a text link
 * instead (doc/design/webui.md "SafeMarkdown").
 */
export function TextImage({ src, alt }: ImageProps) {
	const verdict = inspectUrl(src);
	const label = typeof alt === "string" && alt.trim().length > 0 ? alt.trim() : "image";
	if (!verdict.allowed) {
		return (
			<span data-image="blocked" data-image-src={typeof src === "string" ? src : ""}>
				<Trans>[image: {label}]</Trans>
			</span>
		);
	}
	return (
		<a href={verdict.url} rel="noopener noreferrer" target="_blank" data-image="link">
			<Trans>[image: {label}]</Trans>
		</a>
	);
}
