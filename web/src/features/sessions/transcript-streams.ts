import { StreamingTextStore } from "@/markdown/stream-store";
import type { SessionState, TextBlock, ThinkingBlock } from "./sessionState";

/**
 * The per-row text stores of one session view (doc/webui.md "流式输出").
 *
 * The transcript structure (which rows exist) is React state, but the text of
 * the message being generated and of a running tool call is not: it lives here
 * and only the row that subscribes to its store re-renders. `sync()` feeds the
 * authoritative reducer state after every event batch; a row asks for its
 * store during render, so the row can show text that arrived before React
 * committed the structural update (a new text block is published once, then
 * its store keeps growing without touching the list).
 */
export class TranscriptStreams {
	private readonly texts = new Map<string, StreamingTextStore>();
	private readonly tools = new Map<string, StreamingTextStore>();
	private readonly listeners = new Set<() => void>();
	private notifyFrame: number | null = null;

	/** The store of a streaming text / thinking block, keyed like its transcript item. */
	text(key: string): StreamingTextStore {
		let store = this.texts.get(key);
		if (!store) {
			store = new StreamingTextStore();
			this.texts.set(key, store);
		}
		return store;
	}

	/** The store of a running tool call's live output. */
	tool(callId: string): StreamingTextStore {
		let store = this.tools.get(callId);
		if (!store) {
			store = new StreamingTextStore();
			this.tools.set(callId, store);
		}
		return store;
	}

	/**
	 * Called once per animation frame while text flows, so the scroll container
	 * can re-pin to the bottom without re-rendering any row.
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		if (this.notifyFrame !== null) return;
		const schedule =
			typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
		this.notifyFrame = schedule(() => {
			this.notifyFrame = null;
			for (const listener of this.listeners) listener();
		}) as unknown as number;
	}

	/** Publish the streaming text of `state` into the stores and drop the ones whose block ended. */
	sync(state: SessionState): void {
		const live = new Set<string>();
		state.streaming?.content.forEach((block, index) => {
			const key = `streaming/${index}`;
			if (block.type === "text") {
				live.add(key);
				this.text(key).setText((block as TextBlock).text);
			} else if (block.type === "thinking") {
				live.add(key);
				this.text(key).setText((block as ThinkingBlock).thinking);
			}
		});
		for (const [key, store] of this.texts) {
			if (live.has(key)) continue;
			store.dispose();
			this.texts.delete(key);
		}

		const liveTools = new Set<string>();
		for (const tool of Object.values(state.tools)) {
			liveTools.add(tool.callId);
			this.tool(tool.callId).setText(tool.output);
		}
		for (const [callId, store] of this.tools) {
			if (liveTools.has(callId)) continue;
			store.dispose();
			this.tools.delete(callId);
		}
		if (live.size > 0 || liveTools.size > 0) this.notify();
	}

	disposeAll(): void {
		for (const store of this.texts.values()) store.dispose();
		for (const store of this.tools.values()) store.dispose();
		this.texts.clear();
		this.tools.clear();
	}
}
