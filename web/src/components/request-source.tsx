import type { RequestSource as RequestSourceValue } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { UserLink } from "@/components/user-link";
import { displaySessionTitle } from "@/lib/session-title";
import { cn } from "@/lib/utils";
import { InternalLink } from "./internal-link";

/** A session's display name: its title, or the one untitled-session wording the whole UI uses. */
export function sourceSessionName(i18n: I18n, title: string): string {
	return displaySessionTitle(title, i18n);
}

/**
 * A request source as plain text, for a hover title or a place that cannot render a component. The visible
 * component below is the same model with its links.
 */
export function requestSourceText(i18n: I18n, source: RequestSourceValue): string {
	switch (source.type) {
		case "session":
			return i18n._(msg`Session ${sourceSessionName(i18n, source.title)}`);
		case "api_token":
			return i18n._(msg`API token ${source.name}`);
		case "user":
			return i18n._(msg`User ${source.username}`);
		case "system":
			return i18n._(msg`System`);
		case "auto_review":
			return i18n._(msg`Auto Review`);
		case "schedule":
			return i18n._(msg`Schedule ${source.name}`);
	}
}

/**
 * Who a request came from (doc/design/webui.md "Shared components"): only the source's type and name, in one
 * component every surface shares. A session title links to the session, a user to their page; an API token
 * and the audit-only actors stay plain text.
 */
export function RequestSource({
	source,
	className,
	title,
}: {
	source: RequestSourceValue;
	className?: string;
	/** A tooltip, e.g. the raw actor id on the audit page. */
	title?: string;
}) {
	const { i18n } = useLingui();
	switch (source.type) {
		case "session":
			return (
				<span className={className} title={title}>
					<Trans>
						Session{" "}
						<InternalLink to="/sessions/$sessionId" params={{ sessionId: source.sessionId }}>
							{sourceSessionName(i18n, source.title)}
						</InternalLink>
					</Trans>
				</span>
			);
		case "api_token":
			return (
				<span className={cn("min-w-0", className)} title={title}>
					<Trans>API token {source.name}</Trans>
				</span>
			);
		case "user":
			return (
				<span className={className} title={title}>
					<Trans>
						User <UserLink id={source.userId} name={source.username} />
					</Trans>
				</span>
			);
		case "system":
			return (
				<span className={className} title={title}>
					<Trans>System</Trans>
				</span>
			);
		case "auto_review":
			return (
				<span className={className} title={title}>
					<Trans>Auto Review</Trans>
				</span>
			);
		case "schedule":
			return (
				<span className={cn("min-w-0 truncate", className)} title={title}>
					<Trans>Schedule {source.name}</Trans>
				</span>
			);
	}
}
