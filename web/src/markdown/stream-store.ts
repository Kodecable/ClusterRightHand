import { useSyncExternalStore } from "react";

/**
 * The store a streaming message's text lives in (doc/design/webui.md "Streaming output").
 *
 * The SSE/agent writer calls `setText` as often as it likes; React is only
 * notified once per animation frame, so a fast stream does not turn into one
 * render per character. The session view subscribes with `useStreamingText`,
 * and the message list itself only re-renders when the message count changes.
 */
export interface StreamingTextSnapshot {
	text: string;
	streaming: boolean;
}

export class StreamingTextStore {
	private value = "";
	private pending = "";
	private frame: number | ReturnType<typeof setTimeout> | null = null;
	private readonly listeners = new Set<() => void>();
	private done = false;
	private disposed = false;
	private snapshot: StreamingTextSnapshot = { text: "", streaming: true };
	private readonly scheduleFrame: (callback: () => void) => number | ReturnType<typeof setTimeout>;
	private readonly cancelFrame: (handle: number | ReturnType<typeof setTimeout>) => void;

	constructor() {
		if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
			this.scheduleFrame = (callback) => window.requestAnimationFrame(callback);
			this.cancelFrame = (handle) => window.cancelAnimationFrame(handle as number);
		} else {
			this.scheduleFrame = (callback) => setTimeout(callback, 16);
			this.cancelFrame = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>);
		}
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): string => this.value;

	/**
	 * The snapshot `useSyncExternalStore` subscribes to. It carries the streaming flag as well as the
	 * text: `finish()` must re-render even when the final text is unchanged, or the committed message
	 * would keep rendering in streaming mode (and an incomplete display formula would stay source).
	 */
	getRenderSnapshot = (): StreamingTextSnapshot => this.snapshot;

	isDone = (): boolean => this.done;

	private notify(): void {
		this.snapshot = { text: this.value, streaming: !this.done };
		for (const listener of this.listeners) listener();
	}

	/** Replace the text; the published value updates on the next animation frame. */
	setText(text: string): void {
		if (this.disposed || text === this.pending) return;
		this.pending = text;
		if (this.frame !== null) return;
		this.frame = this.scheduleFrame(() => {
			this.frame = null;
			this.publish();
		});
	}

	append(delta: string): void {
		this.setText(this.pending + delta);
	}

	private publish(): void {
		if (this.pending === this.value) return;
		this.value = this.pending;
		this.notify();
	}

	/** Publish the pending text immediately (tests and the final stream event). */
	flush(): void {
		if (this.frame !== null) {
			this.cancelFrame(this.frame);
			this.frame = null;
		}
		this.publish();
	}

	/** The stream ended: publish everything and let the renderer drop its streaming mode. */
	finish(): void {
		this.flush();
		if (this.done) return;
		this.done = true;
		this.notify();
	}

	/** End of life for this message (unmount, session switch). */
	dispose(): void {
		this.disposed = true;
		if (this.frame !== null) {
			this.cancelFrame(this.frame);
			this.frame = null;
		}
		this.listeners.clear();
	}
}

export function useStreamingText(store: StreamingTextStore): StreamingTextSnapshot {
	return useSyncExternalStore(store.subscribe, store.getRenderSnapshot, store.getRenderSnapshot);
}
