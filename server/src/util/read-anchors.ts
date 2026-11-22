/**
 * Read anchors (doc/design/agent-runtime.md "Read anchors"): where earlier pages of a file ended, so a deeper
 * page starts there instead of at the first byte. An anchor is a hint, never a correctness input: the
 * reader checks it against the file before using it, and any mismatch reads from the start.
 *
 * One bounded in-memory store for all of crhs, keyed by the file (a library object's SHA-256, or an SSH
 * node's path) and tagged with the file's version. A restart forgets every anchor, which costs one scan.
 */

import type { LineAnchor } from "./line-page.ts";

/** An anchor, with the SHA-256 of the bytes before it when the reader must check them (SFTP). */
export interface StoredAnchor extends LineAnchor {
	window?: string;
}

interface FileAnchors {
	version: string;
	anchors: StoredAnchor[];
}

/** Files remembered, least recently used first out. */
const MAX_FILES = 1024;
/** Anchors kept per file; the oldest go first. */
const MAX_ANCHORS = 64;

export class ReadAnchors {
	readonly #files = new Map<string, FileAnchors>();

	/** The anchor with the greatest line not past `line`, for this version of the file. */
	best(key: string, version: string, line: number): StoredAnchor | undefined {
		const entry = this.#files.get(key);
		if (entry === undefined) return undefined;
		if (entry.version !== version) {
			this.#files.delete(key);
			return undefined;
		}
		this.#files.delete(key);
		this.#files.set(key, entry);
		let best: StoredAnchor | undefined;
		for (const anchor of entry.anchors) {
			if (anchor.line <= line && anchor.line > 1 && (best === undefined || anchor.line > best.line)) best = anchor;
		}
		return best;
	}

	/** Whether this version of the file already has an anchor at `line`. */
	has(key: string, version: string, line: number): boolean {
		const entry = this.#files.get(key);
		return entry?.version === version && entry.anchors.some((anchor) => anchor.line === line);
	}

	/** Remembers anchors of a file's version; another version's anchors are dropped. */
	add(key: string, version: string, anchors: readonly StoredAnchor[]): void {
		const useful = anchors.filter((anchor) => anchor.line > 1);
		if (useful.length === 0) return;
		let entry = this.#files.get(key);
		if (entry === undefined || entry.version !== version) entry = { version, anchors: [] };
		this.#files.delete(key);
		for (const anchor of useful) {
			if (entry.anchors.some((known) => known.line === anchor.line)) continue;
			entry.anchors.push(anchor);
		}
		if (entry.anchors.length > MAX_ANCHORS) entry.anchors.splice(0, entry.anchors.length - MAX_ANCHORS);
		this.#files.set(key, entry);
		while (this.#files.size > MAX_FILES) {
			const oldest = this.#files.keys().next().value;
			if (oldest === undefined) break;
			this.#files.delete(oldest);
		}
	}
}
