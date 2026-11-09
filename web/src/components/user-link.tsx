import { Link } from "@tanstack/react-router";
import { cn, linkClass } from "@/lib/utils";

/**
 * A link to a user's page (doc/webui.md "列表导航", "链接"): actors and owners are
 * linked whether or not the viewer may open the page; the destination answers
 * with its no-access message. `relative z-10` keeps the link clickable above a
 * list row's stretched link.
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
		<Link
			to="/users/$userId"
			params={{ userId: id }}
			title={title}
			className={cn("relative z-10", linkClass, className)}
		>
			{name === undefined || name === null || name === "" ? id : name}
		</Link>
	);
}
