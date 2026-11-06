import { useLingui } from "@lingui/react/macro";
import { Link, useRouterState } from "@tanstack/react-router";
import { TerminalSquareIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	useSidebar,
} from "@/components/ui/sidebar";
import { useApprovals } from "@/features/approvals/api";
import { pendingCount } from "@/features/approvals/pending";
import { useAuth } from "@/features/auth/session";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, type NavItem } from "./nav";
import { UserMenu } from "./user-menu";

function Logo() {
	return (
		<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
			<TerminalSquareIcon className="size-4" />
		</div>
	);
}

/**
 * The navigation sidebar: three groups, the approvals badge, the user menu and
 * the collapsed-icon mode with tooltips (doc/webui.md "外壳").
 */
export function AppSidebar() {
	const { i18n, t } = useLingui();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const user = useAuth().user;
	const approvals = useApprovals();
	// Tooltips belong to the collapsed desktop icon rail. Rendering them in the
	// mobile drawer lets a focused nav item open a tooltip, and Base UI's topmost
	// layer then consumes the first Escape (closing the tooltip, not the drawer).
	const { isMobile, state } = useSidebar();
	const tooltipFor = (label: string) => (!isMobile && state === "collapsed" ? label : undefined);
	const pending = pendingCount(approvals.data);

	const isActive = (item: NavItem) => pathname === item.to || pathname.startsWith(`${item.to}/`);
	const visible = (item: NavItem) => !item.adminOnly || user?.kind === "admin";

	// Arrow-key navigation across the sidebar links, in addition to native Tab.
	const onNavKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const root = event.currentTarget;
		const links = Array.from(root.querySelectorAll<HTMLElement>("a[data-nav-link]")).filter(
			(link) => link.offsetParent !== null,
		);
		if (links.length === 0) return;
		const current = links.indexOf(document.activeElement as HTMLElement);
		let next: number;
		if (event.key === "Home") next = 0;
		else if (event.key === "End") next = links.length - 1;
		else if (current === -1) next = 0;
		else next = Math.min(links.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
		event.preventDefault();
		links[next]?.focus();
	};

	return (
		<Sidebar collapsible="icon" data-testid="app-sidebar">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							size="lg"
							tooltip={tooltipFor("ClusterRightHand")}
							render={<Link to="/sessions" data-testid="brand-home" aria-label="ClusterRightHand" />}
						>
							<Logo />
							<div className="grid flex-1 text-left leading-tight">
								<span className="truncate text-sm font-semibold">ClusterRightHand</span>
								<span className="truncate text-xs text-muted-foreground">{t`Ops console`}</span>
							</div>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>

			<SidebarContent onKeyDown={onNavKeyDown}>
				{NAV_GROUPS.map((group) => {
					const items = group.items.filter(visible);
					if (items.length === 0) return null;
					return (
						<SidebarGroup key={group.label.id}>
							<SidebarGroupLabel>{i18n._(group.label)}</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu className="gap-1">
									{items.map((item) => {
										const Icon = item.icon;
										const active = isActive(item);
										return (
											<SidebarMenuItem key={item.to}>
												<SidebarMenuButton
													isActive={active}
													tooltip={tooltipFor(i18n._(item.label))}
													render={
														<Link
															to={item.to}
															data-nav-link
															data-testid={`nav-${item.to.replace(/^\//, "").replace(/\//g, "-")}`}
															aria-current={active ? "page" : undefined}
														/>
													}
												>
													<Icon />
													<span>{i18n._(item.label)}</span>
												</SidebarMenuButton>
												{item.badge === "approvals" && pending > 0 && (
													<SidebarMenuBadge
														data-testid="nav-approvals-badge"
														className={cn(
															"bg-primary text-primary-foreground",
															// SidebarMenuBadge tints its text on hover/when the item is active;
															// these later variants win over its peer-* base classes.
															"peer-hover/menu-button:text-primary-foreground peer-data-active/menu-button:text-primary-foreground",
														)}
														aria-label={t`Pending approvals`}
													>
														{pending > 99 ? "99+" : pending}
													</SidebarMenuBadge>
												)}
											</SidebarMenuItem>
										);
									})}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					);
				})}
			</SidebarContent>

			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<UserMenu />
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
