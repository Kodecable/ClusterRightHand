import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	BadgeCheckIcon,
	BoxesIcon,
	CalendarClockIcon,
	GraphHubIcon,
	KeyRoundIcon,
	KeySquareIcon,
	LibraryIcon,
	ListChecksIcon,
	LockKeyholeIcon,
	type LucideIcon,
	MessageSquareIcon,
	ScrollTextIcon,
	ServerIcon,
	SettingsIcon,
	ShieldCheckIcon,
	UsersIcon,
} from "lucide-react";

/**
 * The sidebar's groups and items (doc/design/webui.md "Shell, theme and language"). Labels are Lingui
 * descriptors; items marked `adminOnly` are hidden from non-admins.
 */

export type NavPath =
	| "/sessions"
	| "/library"
	| "/schedules"
	| "/tasks"
	| "/approvals"
	| "/nodes"
	| "/node-groups"
	| "/ssh-credentials"
	| "/signing-credentials"
	| "/authorizations"
	| "/tokens"
	| "/audit"
	| "/settings/models"
	| "/settings/system"
	| "/users";

export interface NavItem {
	to: NavPath;
	label: MessageDescriptor;
	icon: LucideIcon;
	adminOnly?: boolean;
	/** Shows the pending approvals count. */
	badge?: "approvals";
	/** Further paths this one entry also highlights, e.g. user groups under Users. */
	activeFor?: readonly string[];
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
			{ to: "/library", label: msg`Library`, icon: LibraryIcon },
			{ to: "/schedules", label: msg`Schedules`, icon: CalendarClockIcon },
			{ to: "/tasks", label: msg`Tasks`, icon: ListChecksIcon, activeFor: ["/task-groups"] },
			{ to: "/approvals", label: msg`Approvals`, icon: ShieldCheckIcon, badge: "approvals" },
		],
	},
	{
		label: msg`Cluster`,
		items: [
			{ to: "/nodes", label: msg`Nodes`, icon: ServerIcon },
			{ to: "/node-groups", label: msg`Node groups`, icon: GraphHubIcon },
			{ to: "/ssh-credentials", label: msg`SSH credentials`, icon: LockKeyholeIcon, adminOnly: true },
			{ to: "/signing-credentials", label: msg`Signing credentials`, icon: KeyRoundIcon },
		],
	},
	{
		label: msg`Admin`,
		items: [
			{ to: "/authorizations", label: msg`Authorizations`, icon: BadgeCheckIcon, adminOnly: true },
			{ to: "/tokens", label: msg`API tokens`, icon: KeySquareIcon },
			{ to: "/audit", label: msg`Audit`, icon: ScrollTextIcon },
			{ to: "/settings/models", label: msg`Models`, icon: BoxesIcon, adminOnly: true },
			{ to: "/settings/system", label: msg`System settings`, icon: SettingsIcon, adminOnly: true },
			{ to: "/users", label: msg`Users`, icon: UsersIcon, adminOnly: true, activeFor: ["/user-groups"] },
		],
	},
];

export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** The longest nav path that prefixes `pathname` (so /sessions/123 highlights Sessions). */
export function navItemForPath(pathname: string): NavItem | undefined {
	return NAV_ITEMS.flatMap((item) => [item.to, ...(item.activeFor ?? [])].map((path) => ({ item, path })))
		.sort((a, b) => b.path.length - a.path.length)
		.find(({ path }) => pathname === path || pathname.startsWith(`${path}/`))?.item;
}
