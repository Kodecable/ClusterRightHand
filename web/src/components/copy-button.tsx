import { Trans, useLingui } from "@lingui/react/macro";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export interface CopyButtonProps {
	text: string;
	/** Accessible name; defaults to "Copy". Pass a more specific one for long commands. */
	label?: string;
	className?: string;
	showLabel?: boolean;
	size?: React.ComponentProps<typeof Button>["size"];
	variant?: React.ComponentProps<typeof Button>["variant"];
}

/** Copies text and confirms it inline for a moment. */
export function CopyButton({
	text,
	label,
	className,
	showLabel = false,
	size = "icon-sm",
	variant = "ghost",
}: CopyButtonProps) {
	const { t } = useLingui();
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timer.current !== null) clearTimeout(timer.current);
		};
	}, []);

	const copy = useCallback(async () => {
		const ok = await copyText(text);
		setCopied(ok);
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 1_500);
	}, [text]);

	return (
		<Button
			type="button"
			variant={variant}
			size={showLabel ? "sm" : size}
			className={cn(className)}
			aria-label={label ?? t`Copy`}
			title={label ?? t`Copy`}
			onClick={() => void copy()}
			data-copied={copied ? "true" : "false"}
		>
			{copied ? <CheckIcon className="text-ok" /> : <CopyIcon />}
			{showLabel && <span>{copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}</span>}
			<span className="sr-only" aria-live="polite">
				{copied ? <Trans>Copied to clipboard</Trans> : ""}
			</span>
		</Button>
	);
}
