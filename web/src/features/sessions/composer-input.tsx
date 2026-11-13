import { Trans, useLingui } from "@lingui/react/macro";
import { type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect } from "react";

/**
 * Grows a one-row textarea with its draft, up to `maxHeight` pixels. A function
 * is read on every resize instead of being a dependency: the draft page caps at
 * half the window as it is when the draft changes, while the session composer
 * passes the measured number and resizes again when that number changes.
 */
export function useTextareaAutosize(
	ref: RefObject<HTMLTextAreaElement | null>,
	text: string,
	maxHeight: number | (() => number),
): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: the textarea's scrollHeight changes with the draft
	useLayoutEffect(() => {
		const element = ref.current;
		if (element === null) return;
		const cap = typeof maxHeight === "function" ? maxHeight() : maxHeight;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, cap)}px`;
	}, [maxHeight, text]);
}

/**
 * The composer's keys: an IME owns every key while it composes (completing a
 * half-typed kana would be worse than doing nothing), `intercept` sees the key
 * next and returns true when it handled it, and then Enter sends while
 * Shift+Enter adds a line.
 */
export function handleComposerKey(
	event: KeyboardEvent<HTMLTextAreaElement>,
	send: () => void,
	intercept?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean,
): void {
	if (event.nativeEvent.isComposing) return;
	if (intercept?.(event)) return;
	if (event.key !== "Enter" || event.shiftKey) return;
	event.preventDefault();
	send();
}

/**
 * The composer's frame shared by the session and the draft page: the form, the
 * bordered box with the textarea's hidden label, and whatever follows the box
 * inside the form.
 */
export function ComposerShell({
	inputId,
	onSubmit,
	after,
	onDropFiles,
	children,
}: {
	inputId: string;
	onSubmit: () => void;
	after?: ReactNode;
	/** Files dropped anywhere on the composer; omitted when the viewer may not attach. */
	onDropFiles?: (files: File[]) => void;
	children: ReactNode;
}) {
	const { t } = useLingui();
	return (
		<section
			className="shrink-0 bg-background/80 px-3 pt-1 pb-2"
			data-slot="composer"
			aria-label={t`Message composer`}
			onDragOver={(event) => {
				if (onDropFiles === undefined) return;
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault();
			}}
			onDrop={(event) => {
				if (onDropFiles === undefined) return;
				const files = [...event.dataTransfer.files];
				if (files.length === 0) return;
				event.preventDefault();
				onDropFiles(files);
			}}
		>
			<form
				onSubmit={(event: FormEvent) => {
					event.preventDefault();
					onSubmit();
				}}
			>
				<div className="relative rounded-xl border border-input bg-background shadow-sm transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30">
					<label className="sr-only" htmlFor={inputId}>
						<Trans>Message</Trans>
					</label>
					{children}
				</div>
				{after}
			</form>
		</section>
	);
}

/** The hint under a lone `/token` that names no command: it is still sent as a normal message. */
export function UnknownCommandHint() {
	return (
		<p className="px-3 pb-1 text-xs text-muted-foreground" data-testid="slash-hint">
			<Trans>Unknown command: it will be sent as a message.</Trans>
		</p>
	);
}
