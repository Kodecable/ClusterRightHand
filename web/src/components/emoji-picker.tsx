import { useLingui } from "@lingui/react/macro";
import {
	defaultEmojiDataResolver,
	type EmojiData,
	type EmojiDataResolver,
	type EmojiPickerListCategoryHeaderProps,
	type EmojiPickerListEmojiProps,
	type EmojiPickerListRowProps,
	EmojiPicker as EmojiPickerPrimitive,
} from "frimousse";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Exactly one RGI emoji, the same check crhs applies to a stored emoji (`server/src/util/emoji.ts`). The
 * `v` flag needs a modern browser, which the WebUI already requires (doc/design/webui.md "Frontend
 * architecture").
 */
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

/** Whether crhs would accept `emoji` as a node or node group emoji. */
export function isRgiEmoji(emoji: string): boolean {
	return RGI_EMOJI.test(emoji);
}

/**
 * Drops the emoji crhs would reject. Emojibase 18 ships Emoji 18 entries, while the running JavaScript
 * engine's `RGI_Emoji` (and therefore crhs's validator) may stop at an earlier version; offering one would
 * make the save fail. Filtering the resolved data keeps the picker and the server on the same set.
 */
export function supportedEmojiData(data: EmojiData): EmojiData {
	return { ...data, emojis: data.emojis.filter((entry) => isRgiEmoji(entry.emoji)) };
}

/** The frimousse data resolver, filtered to the emoji crhs accepts. */
export const resolveRgiEmojiData: EmojiDataResolver = async (locale, options) =>
	supportedEmojiData(await defaultEmojiDataResolver(locale, options));

/** A sticky category header of the emoji list. */
function CategoryHeader({ category, ...props }: EmojiPickerListCategoryHeaderProps) {
	return (
		<div {...props} className="bg-popover px-2 py-1 text-xs font-medium text-muted-foreground">
			{category.label}
		</div>
	);
}

/** One row of emoji buttons; frimousse sizes and positions it. */
function Row(props: EmojiPickerListRowProps) {
	return <div {...props} className="flex" />;
}

/** One emoji: a button that keeps frimousse's ARIA and keyboard attributes. */
function EmojiButton({ emoji: entry, ...props }: EmojiPickerListEmojiProps) {
	return (
		<button
			type="button"
			{...props}
			className={cn(
				"flex size-8 items-center justify-center rounded-md text-lg leading-none outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
				entry.isActive && "bg-muted",
			)}
		>
			{entry.emoji}
		</button>
	);
}

/**
 * The frimousse emoji picker in the WebUI's popover style (doc/design/webui.md "Node pages"). It is
 * loaded lazily by `EntityEmoji`, so frimousse never joins the main chunk.
 *
 * The emoji data is served by crhs itself: Vite copies the four files frimousse asks for under
 * `/emojibase`, and `emojibaseUrl` points there. `zh` is the Chinese data set, `en` everything else.
 */
export default function EmojiPicker({
	emoji,
	onSelect,
}: {
	emoji: string | null;
	onSelect: (emoji: string | null) => void;
}) {
	const { i18n, t } = useLingui();
	const locale = i18n.locale === "zh-CN" ? "zh" : "en";

	return (
		<div className="flex min-h-0 flex-col gap-2" data-testid="emoji-picker">
			<EmojiPickerPrimitive.Root
				locale={locale}
				emojibaseUrl={`${import.meta.env.BASE_URL}emojibase`}
				resolveEmojiData={resolveRgiEmojiData}
				columns={8}
				onEmojiSelect={(selected) => onSelect(selected.emoji)}
				className="flex min-h-0 flex-col gap-2"
			>
				<EmojiPickerPrimitive.Search
					autoFocus
					aria-label={t`Search emoji`}
					placeholder={t`Search emoji`}
					className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
					data-testid="emoji-search"
				/>
				<EmojiPickerPrimitive.Viewport className="h-64 overflow-y-auto overscroll-contain rounded-md">
					<EmojiPickerPrimitive.Loading className="block px-2 py-6 text-center text-sm text-muted-foreground">
						{t`Loading emoji…`}
					</EmojiPickerPrimitive.Loading>
					<EmojiPickerPrimitive.Empty className="block px-2 py-6 text-center text-sm text-muted-foreground">
						{t`No emoji found`}
					</EmojiPickerPrimitive.Empty>
					<EmojiPickerPrimitive.List
						components={{ CategoryHeader, Row, Emoji: EmojiButton }}
						data-testid="emoji-list"
					/>
				</EmojiPickerPrimitive.Viewport>
			</EmojiPickerPrimitive.Root>
			{emoji !== null && emoji !== "" && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => onSelect(null)}
					data-testid="remove-emoji"
					className="self-end"
				>
					<Trash2Icon aria-hidden="true" />
					{t`Remove emoji`}
				</Button>
			)}
		</div>
	);
}
