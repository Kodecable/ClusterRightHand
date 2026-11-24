import { Trans } from "@lingui/react/macro";
import type { Terminal } from "@xterm/xterm";
import { KeyboardIcon } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { readStorage, writeStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { EXTRA_KEYS, type ExtraKey, pressExtraKey, type StickyModifiers } from "./user-input";

/** Per-viewer visibility of the bar, remembered in this browser. */
const STORAGE_KEY = "crh.terminals.extra-keys";
/** The bar's coarse-pointer default: touch devices show it, desktops hide it. */
const COARSE_POINTER = "(pointer: coarse)";

function storedVisibility(): boolean | undefined {
	const stored = readStorage(STORAGE_KEY);
	return stored === null ? undefined : stored === "show";
}

function coarsePointer(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia(COARSE_POINTER).matches;
}

function KeyButton({ label, testId, onClick }: { label: string; testId: string; onClick: () => void }) {
	return (
		<button
			type="button"
			data-testid={testId}
			className="h-8 shrink-0 rounded-md border bg-background px-2 font-mono text-xs whitespace-nowrap hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			onMouseDown={(event) => event.preventDefault()}
			onClick={onClick}
		>
			{label}
		</button>
	);
}

function StickyButton({
	label,
	active,
	locked,
	testId,
	onClick,
}: {
	label: string;
	active: boolean;
	locked: boolean;
	testId: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid={testId}
			data-active={active ? "true" : undefined}
			data-locked={locked ? "true" : undefined}
			aria-pressed={active}
			className={cn(
				"h-8 shrink-0 rounded-md border px-2 text-xs whitespace-nowrap",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
				active
					? "border-primary bg-primary/15 font-medium text-primary ring-1 ring-primary/40"
					: "bg-background hover:bg-muted",
			)}
			onMouseDown={(event) => event.preventDefault()}
			onClick={onClick}
		>
			{label}
		</button>
	);
}

/**
 * The extra-keys bar under a terminal (doc/design/webui.md "Terminals page"): Esc, Tab, sticky
 * Ctrl and Alt, the arrows, Home, End, PgUp, PgDn and the punctuation a shell needs. It scrolls
 * horizontally when it does not fit. Touch devices show it by default; the button toggles it and
 * remembers the choice per viewer, also when storage is unavailable. The viewer measures the bar
 * through `barRef`, because the bar's height comes out of the terminal's height budget; the ref is
 * null while the bar is hidden. `hint` sits on the toggle's row, left of it, and wraps with it on a
 * narrow screen.
 */
export function ExtraKeysBar({
	terminalRef,
	sticky,
	barRef,
	hint,
}: {
	terminalRef: { readonly current: Terminal | undefined };
	sticky: StickyModifiers;
	barRef?: Ref<HTMLDivElement>;
	hint?: ReactNode;
}) {
	const [visible, setVisible] = useState<boolean>(() => storedVisibility() ?? coarsePointer());
	const snapshot = useSyncExternalStore(
		sticky.subscribe,
		() => sticky.snapshot,
		() => sticky.snapshot,
	);

	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const media = window.matchMedia(COARSE_POINTER);
		const onChange = () => {
			// A choice the viewer made wins over the device default.
			if (storedVisibility() === undefined) setVisible(media.matches);
		};
		media.addEventListener?.("change", onChange);
		return () => media.removeEventListener?.("change", onChange);
	}, []);

	const toggle = () => {
		const next = !visible;
		setVisible(next);
		writeStorage(STORAGE_KEY, next ? "show" : "hide");
	};

	const send = (key: ExtraKey) => {
		const terminal = terminalRef.current;
		if (terminal !== undefined) pressExtraKey(terminal, key, sticky);
	};
	const stickyButton = (modifier: "ctrl" | "alt", label: string) => {
		const state = snapshot[modifier];
		return (
			<StickyButton
				key={modifier}
				label={label}
				active={state !== "off"}
				locked={state === "locked"}
				testId={`extra-key-${modifier}`}
				onClick={() => sticky.tap(modifier)}
			/>
		);
	};
	const keyButton = (id: string) => {
		const key = EXTRA_KEYS.find((entry) => entry.id === id);
		if (key === undefined) return null;
		return <KeyButton key={key.id} label={key.label} testId={`extra-key-${key.id}`} onClick={() => send(key)} />;
	};

	return (
		<div className="grid min-w-0 gap-1" data-testid="terminal-extra-keys">
			<div
				className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1"
				data-testid="terminal-extra-keys-header"
			>
				{hint}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ml-auto"
					aria-pressed={visible}
					data-testid="terminal-extra-keys-toggle"
					onClick={toggle}
				>
					<KeyboardIcon />
					<Trans>Extra keys</Trans>
				</Button>
			</div>
			{visible && (
				<div
					ref={barRef}
					data-testid="terminal-extra-keys-bar"
					className="flex min-w-0 max-w-full flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain pb-1"
				>
					{keyButton("escape")}
					{keyButton("tab")}
					{stickyButton("ctrl", "Ctrl")}
					{stickyButton("alt", "Alt")}
					{keyButton("up")}
					{keyButton("down")}
					{keyButton("left")}
					{keyButton("right")}
					{keyButton("home")}
					{keyButton("end")}
					{keyButton("pageUp")}
					{keyButton("pageDown")}
					{keyButton("pipe")}
					{keyButton("tilde")}
					{keyButton("slash")}
					{keyButton("dash")}
				</div>
			)}
		</div>
	);
}
