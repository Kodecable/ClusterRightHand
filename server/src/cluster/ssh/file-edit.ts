import { FileTaskError } from "./file-sftp.ts";

export const MAX_EDIT_SIZE = 16 << 20;

export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// All matching below runs on latin1-decoded strings so it is byte-exact, like Go's string ops.

export function detectLineEnding(s: string): string {
	const lf = s.indexOf("\n");
	const crlf = s.indexOf("\r\n");
	if (lf === -1 || crlf === -1 || crlf > lf) {
		return "\n";
	}
	return "\r\n";
}

export function normalizeToLF(s: string): string {
	return s.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export const toBytesString = (s: string): string => Buffer.from(s, "utf8").toString("latin1");

function countNonOverlapping(s: string, sub: string): number {
	let n = 0;
	for (let i = s.indexOf(sub); i >= 0; i = s.indexOf(sub, i + sub.length)) {
		n++;
	}
	return n;
}

interface Matched {
	index: number;
	start: number;
	length: number;
	newText: string;
}

/**
 * Matches every edit against the original content (exactly once, without overlap) and applies
 * them all at once. `edits` texts are byte strings (latin1).
 */
export function applyEdits(content: string, edits: { oldText: string; newText: string }[], path: string): string {
	const matched: Matched[] = [];
	edits.forEach((e, i) => {
		const old = normalizeToLF(e.oldText);
		if (old === "") {
			throw new FileTaskError("invalid_spec", `edits[${i}].old_text must not be empty in ${path}`);
		}
		const idx = content.indexOf(old);
		if (idx < 0) {
			throw new FileTaskError(
				"edit_no_match",
				`could not find edits[${i}] in ${path}; old_text must match exactly including whitespace and newlines`,
			);
		}
		const n = countNonOverlapping(content, old);
		if (n > 1) {
			throw new FileTaskError(
				"edit_ambiguous",
				`found ${n} occurrences of edits[${i}] in ${path}; add more context to make it unique`,
			);
		}
		matched.push({ index: i, start: idx, length: old.length, newText: normalizeToLF(e.newText) });
	});
	matched.sort((a, b) => a.start - b.start);
	for (let i = 1; i < matched.length; i++) {
		const p = matched[i - 1] as Matched;
		const c = matched[i] as Matched;
		if (p.start + p.length > c.start) {
			throw new FileTaskError("edit_overlap", `edits[${p.index}] and edits[${c.index}] overlap in ${path}`);
		}
	}
	let out = "";
	let pos = 0;
	for (const m of matched) {
		out += content.slice(pos, m.start) + m.newText;
		pos = m.start + m.length;
	}
	out += content.slice(pos);
	if (out === content) {
		throw new FileTaskError(
			"edit_no_change",
			`no changes made to ${path}; the replacements produced identical content`,
		);
	}
	return out;
}
