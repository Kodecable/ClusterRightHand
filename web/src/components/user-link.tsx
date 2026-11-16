import { InternalLink } from "./internal-link";

/**
 * A link to a user's page (doc/design/webui.md "List navigation, links and refresh", "Links"): actors and owners are
 * linked whether or not the viewer may open the page; the destination answers
 * with its no-access message.
 */
export function UserLink({
	id,
	name,
	className,
	title,
}: {
	id: string;
	/** The display name when known; the raw id otherwise. */
	name?: string | null;
	className?: string;
	title?: string;
}) {
	return (
		<InternalLink to="/users/$userId" params={{ userId: id }} title={title} className={className}>
			{name === undefined || name === null || name === "" ? id : name}
		</InternalLink>
	);
}
