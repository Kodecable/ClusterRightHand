import { Trans, useLingui } from "@lingui/react/macro";
import {
	ChevronsUpDownIcon,
	KeyRoundIcon,
	LanguagesIcon,
	LogOutIcon,
	MonitorIcon,
	MoonIcon,
	SunIcon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLogout } from "@/features/auth/api";
import { useAuth } from "@/features/auth/session";
import { useLocale } from "@/lib/i18n";
import type { ThemePreference } from "@/lib/theme";
import { useTheme } from "@/lib/theme";

// The dialog is the only user of react-hook-form and zod; keep them out of the
// entry chunk by loading it when the menu item is used (WU2a audit fix).
const ChangePasswordDialog = lazy(() =>
	import("@/features/auth/change-password-dialog").then((module) => ({ default: module.ChangePasswordDialog })),
);

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
	return `${(parts[0] as string)[0] ?? ""}${(parts[1] as string)[0] ?? ""}`.toUpperCase();
}

/**
 * The user menu at the bottom of the sidebar: theme, language, change password
 * and log out (doc/design/webui.md "Shell"). The trigger is a native button composed via
 * Base UI's `render` prop; the generated `SidebarMenuButton` is not forwarded as
 * a menu trigger because Base UI merges the trigger's props and ref into the
 * rendered element, which the wrapper would lose.
 */
export function UserMenu() {
	const { t } = useLingui();
	const auth = useAuth();
	const { locale, setLocale, switching } = useLocale();
	const { preference, setPreference } = useTheme();
	const logout = useLogout();
	const [passwordOpen, setPasswordOpen] = useState(false);

	const user = auth.user;
	const name = user?.displayName ?? user?.username ?? "";

	const onLogout = () => {
		logout.mutate();
	};

	const themeOptions: { value: ThemePreference; label: string; icon: typeof SunIcon }[] = [
		{ value: "light", label: t`Light`, icon: SunIcon },
		{ value: "dark", label: t`Dark`, icon: MoonIcon },
		{ value: "system", label: t`System`, icon: MonitorIcon },
	];

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<button
							type="button"
							data-testid="user-menu-trigger"
							aria-label={t`Account menu`}
							title={t`Account menu`}
							className="flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2!"
						/>
					}
				>
					<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-xs font-semibold">
						{initials(name)}
					</span>
					<div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
						<span className="truncate text-sm font-medium">{name}</span>
						<span className="truncate text-xs text-muted-foreground">{user?.email ?? user?.username ?? ""}</span>
					</div>
					<ChevronsUpDownIcon className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
				</DropdownMenuTrigger>

				<DropdownMenuContent side="right" align="end" sideOffset={8} className="w-60" data-testid="user-menu">
					<DropdownMenuGroup>
						<DropdownMenuLabel>
							<Trans>Signed in as {name}</Trans>
						</DropdownMenuLabel>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />

					<DropdownMenuSub>
						<DropdownMenuSubTrigger data-testid="menu-theme">
							<SunIcon />
							<Trans>Theme</Trans>
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuRadioGroup
								value={preference}
								onValueChange={(value) => setPreference(value as ThemePreference)}
							>
								{themeOptions.map(({ value, label, icon: Icon }) => (
									<DropdownMenuRadioItem key={value} value={value} data-testid={`theme-${value}`}>
										<Icon />
										{label}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuSubContent>
					</DropdownMenuSub>

					<DropdownMenuSub>
						<DropdownMenuSubTrigger data-testid="menu-language">
							<LanguagesIcon />
							<Trans>Language</Trans>
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuRadioGroup
								value={locale}
								onValueChange={(value) => setLocale(value === "zh-CN" ? "zh-CN" : "en")}
								disabled={switching}
							>
								<DropdownMenuRadioItem value="en" data-testid="language-en">
									English
								</DropdownMenuRadioItem>
								<DropdownMenuRadioItem value="zh-CN" data-testid="language-zh">
									中文 (简体)
								</DropdownMenuRadioItem>
							</DropdownMenuRadioGroup>
						</DropdownMenuSubContent>
					</DropdownMenuSub>

					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuItem data-testid="menu-change-password" onClick={() => setPasswordOpen(true)}>
							<KeyRoundIcon />
							<Trans>Change password</Trans>
						</DropdownMenuItem>
						<DropdownMenuItem data-testid="menu-logout" variant="destructive" onClick={onLogout}>
							<LogOutIcon />
							<Trans>Log out</Trans>
						</DropdownMenuItem>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>

			{passwordOpen && (
				<Suspense fallback={null}>
					<ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
				</Suspense>
			)}
		</>
	);
}
