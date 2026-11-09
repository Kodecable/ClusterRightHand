import { Link } from "@tanstack/react-router";
import { cn, linkClass } from "@/lib/utils";

/**
 * A link to a user's page (doc/webui.md "列表导航", "链接"): actors and owners are
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
		<Link to="/users/$userId" params={{ userId: id }} title={title} className={cn(linkClass, className)}>
			{name === undefined || name === null || name === "" ? id : name}
		</Link>
	);
}
