import { TriangleAlertIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one warning banner (doc/design/webui.md "Shared components"): schedules, the session list and
 * the token dialog all use this bordered warn block instead of their own
 * coloured text line.
 */
export function WarningBanner({
	children,
	className,
	icon = false,
	role = "status",
	...props
}: Omit<ComponentProps<"p">, "children"> & {
	children: ReactNode;
	/** Show the warning triangle; inline banners without it stay text-only. */
	icon?: boolean;
	role?: "status" | "alert";
}) {
	return (
		<p
			role={role}
			data-slot="warning-banner"
			className={cn(
				"flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn",
				className,
			)}
			{...props}
		>
			{icon && <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
			<span className="min-w-0">{children}</span>
		</p>
	);
}
