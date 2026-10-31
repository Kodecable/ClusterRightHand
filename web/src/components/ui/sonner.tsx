import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "@/lib/theme";

/**
 * Sonner toasts, bound to the app theme. The generated shadcn wrapper uses
 * `next-themes`; this project has its own theme provider and does not ship an
 * extra theme library.
 */
export function Toaster(props: React.ComponentProps<typeof SonnerToaster>) {
	const { resolved } = useTheme();
	return <SonnerToaster theme={resolved} position="bottom-right" richColors closeButton {...props} />;
}
