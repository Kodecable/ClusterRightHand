import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Sonner toasts, bound to the app theme. The generated shadcn wrapper uses
 * `next-themes`; this project has its own theme provider and does not ship an
 * extra theme library. A long server error wraps inside the toast instead of
 * widening it.
 */
export function Toaster({ toastOptions, ...props }: React.ComponentProps<typeof SonnerToaster>) {
	const { resolved } = useTheme();
	return (
		<SonnerToaster
			theme={resolved}
			position="bottom-right"
			richColors
			closeButton
			{...props}
			toastOptions={{
				...toastOptions,
				classNames: {
					...toastOptions?.classNames,
					toast: cn("break-words [overflow-wrap:anywhere]", toastOptions?.classNames?.toast),
				},
			}}
		/>
	);
}
