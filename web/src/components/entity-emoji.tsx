import { useLingui } from "@lingui/react/macro";
import { SmilePlusIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The emoji picker is a separate chunk: frimousse, its data loading and the picker's styles are only
 * downloaded when an administrator first opens it (doc/design/webui.md "Node pages").
 */
const EmojiPicker = lazy(() => import("@/components/emoji-picker"));

/**
 * An entity's emoji where it is only shown (doc/design/webui.md "Node pages"): decorative, so screen
 * readers keep hearing the name alone, and nothing at all when it is unset.
 */
export function EmojiGlyph({
	emoji,
	className,
	testId,
}: {
	emoji: string | null;
	className?: string;
	testId?: string;
}) {
	if (emoji === null || emoji === "") return null;
	return (
		<span
			aria-hidden="true"
			data-testid={testId}
			className={cn("inline-block shrink-0 text-base leading-none", className)}
		>
			{emoji}
		</span>
	);
}

/**
 * An entity's emoji in a page heading: read-only for everyone, and for administrators the click target
 * that opens the picker (the glyph itself when set, a small smiley-plus button when not).
 */
export function EntityEmoji({
	emoji,
	editable,
	onSelect,
	busy = false,
	testId,
}: {
	emoji: string | null;
	editable: boolean;
	onSelect?: (emoji: string | null) => void;
	busy?: boolean;
	testId: string;
}) {
	const { t } = useLingui();
	const [open, setOpen] = useState(false);

	if (!editable) return <EmojiGlyph emoji={emoji} testId={testId} />;

	const label = t`Set emoji`;
	const trigger = (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-label={label}
			title={label}
			aria-expanded={open}
			disabled={busy}
			data-testid={`${testId}-button`}
			className={cn(
				"text-base leading-none",
				emoji === null ? "text-muted-foreground/60 hover:text-foreground" : "hover:bg-muted",
			)}
		>
			{emoji === null ? (
				<SmilePlusIcon className="size-4" aria-hidden="true" />
			) : (
				<span aria-hidden="true">{emoji}</span>
			)}
		</Button>
	);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger render={trigger} />
			<PopoverContent align="start" side="bottom" className="w-80 max-w-[calc(100vw-2rem)] p-2">
				{/* Mounted only while open, so the lazy chunk and the emoji data load on first use. */}
				{open && (
					<Suspense
						fallback={
							<div className="flex h-40 items-center justify-center">
								<Spinner decorative />
							</div>
						}
					>
						<EmojiPicker
							emoji={emoji}
							onSelect={(next) => {
								setOpen(false);
								onSelect?.(next);
							}}
						/>
					</Suspense>
				)}
			</PopoverContent>
		</Popover>
	);
}
