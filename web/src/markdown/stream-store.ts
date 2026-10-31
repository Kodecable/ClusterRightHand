import { useSyncExternalStore } from "react";

/**
 * The store a streaming message's text lives in (doc/webui.md "流式输出").
 *
 * The SSE/agent writer calls `setText` as often as it likes; React is only
 * notified once per animation frame, so a fast stream does not turn into one
 * render per character. The session view subscribes with `useStreamingText`,
 * and the message list itself only re-renders when the message count changes.
 */
export class StreamingTextStore {
	private value = "";
	private pending = "";
	private frame: number | ReturnType<typeof setTimeout> | null = null;
	private readonly listeners = new Set<() => void>();
	private done = false;
	private disposed = false;
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

	isDone = (): boolean => this.done;

	private notify(): void {
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

export function useStreamingText(store: StreamingTextStore): { text: string; streaming: boolean } {
	const text = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	// `isDone` is a plain read; `finish` notifies subscribers so this re-renders.
	const streaming = !store.isDone();
	return { text, streaming };
}
