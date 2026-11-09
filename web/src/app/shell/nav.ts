import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	BadgeCheckIcon,
	BoxesIcon,
	CalendarClockIcon,
	GraphHubIcon,
	KeyRoundIcon,
	KeySquareIcon,
	LayersIcon,
	ListChecksIcon,
	LockKeyholeIcon,
	type LucideIcon,
	MessageSquareIcon,
	ScrollTextIcon,
	ServerIcon,
	ShieldCheckIcon,
	UsersIcon,
} from "lucide-react";

/**
 * The sidebar's groups and items (doc/webui.md "外壳"). Labels are Lingui
 * descriptors; items marked `adminOnly` are hidden from non-admins.
 */

export type NavPath =
	| "/sessions"
	| "/schedules"
	| "/tasks"
	| "/batch"
	| "/approvals"
	| "/nodes"
	| "/node-groups"
	| "/ssh-credentials"
	| "/credentials"
	| "/authorizations"
	| "/tokens"
	| "/audit"
	| "/settings/models"
	| "/users";

export interface NavItem {
	to: NavPath;
	label: MessageDescriptor;
	icon: LucideIcon;
	adminOnly?: boolean;
	/** Shows the pending approvals count. */
	badge?: "approvals";
}

export interface NavGroup {
	label: MessageDescriptor;
	items: NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
	{
		label: msg`Work`,
		items: [
			{ to: "/sessions", label: msg`Sessions`, icon: MessageSquareIcon },
			{ to: "/schedules", label: msg`Schedules`, icon: CalendarClockIcon },
			{ to: "/tasks", label: msg`Tasks`, icon: ListChecksIcon },
			{ to: "/batch", label: msg`Batch`, icon: LayersIcon },
			{ to: "/approvals", label: msg`Approvals`, icon: ShieldCheckIcon, badge: "approvals" },
		],
	},
	{
		label: msg`Cluster`,
		items: [
			{ to: "/nodes", label: msg`Nodes`, icon: ServerIcon },
			{ to: "/node-groups", label: msg`Node groups`, icon: GraphHubIcon },
			{ to: "/ssh-credentials", label: msg`SSH credentials`, icon: LockKeyholeIcon, adminOnly: true },
			{ to: "/credentials", label: msg`Credentials`, icon: KeyRoundIcon },
		],
	},
	{
		label: msg`Admin`,
		items: [
			{ to: "/authorizations", label: msg`Authorizations`, icon: BadgeCheckIcon, adminOnly: true },
			{ to: "/tokens", label: msg`API tokens`, icon: KeySquareIcon },
			{ to: "/audit", label: msg`Audit`, icon: ScrollTextIcon },
			{ to: "/settings/models", label: msg`Models`, icon: BoxesIcon, adminOnly: true },
			{ to: "/users", label: msg`Users`, icon: UsersIcon, adminOnly: true },
		],
	},
];

export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** The longest nav path that prefixes `pathname` (so /sessions/123 highlights Sessions). */
export function navItemForPath(pathname: string): NavItem | undefined {
	return [...NAV_ITEMS]
		.sort((a, b) => b.to.length - a.to.length)
		.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
}
