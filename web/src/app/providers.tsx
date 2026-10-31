import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Locale } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";

/** The provider stack around the router (doc/webui.md "前端架构"). */
export function AppProviders({
	queryClient,
	initialLocale,
	children,
}: {
	queryClient: QueryClient;
	initialLocale: Locale;
	children: ReactNode;
}) {
	return (
		<ThemeProvider>
			<LocaleProvider initialLocale={initialLocale}>
				<QueryClientProvider client={queryClient}>
					<TooltipProvider>
						{children}
						<Toaster />
					</TooltipProvider>
				</QueryClientProvider>
			</LocaleProvider>
		</ThemeProvider>
	);
}
