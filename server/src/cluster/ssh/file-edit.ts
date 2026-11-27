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

/**
 * Applies normalizeToLF and maps every normalized byte offset back to the original, so an edit can
 * replace only the bytes its match came from.
 */
function normalizeWithOffsets(s: string): { text: string; offsets: Uint32Array } {
	const raw = Buffer.from(s, "latin1");
	const out = Buffer.allocUnsafe(raw.length);
	const offsets = new Uint32Array(raw.length + 1);
	let n = 0;
	for (let i = 0; i < raw.length; ) {
		offsets[n++] = i;
		if (raw[i] === 0x0d) {
			out[n - 1] = 0x0a;
			i += i + 1 < raw.length && raw[i + 1] === 0x0a ? 2 : 1;
			continue;
		}
		out[n - 1] = raw[i] as number;
		i++;
	}
	offsets[n] = raw.length;
	return { text: out.subarray(0, n).toString("latin1"), offsets: offsets.subarray(0, n + 1) };
}

export const toBytesString = (s: string): string => Buffer.from(s, "utf8").toString("latin1");

/**
 * Counts every start position of `sub`, including overlapping ones. KMP keeps this linear in the
 * file size even for a long repeated substring such as `aaaa...` / `aa`.
 */
function countMatches(s: string, sub: string): number {
	if (sub === "") return 0;
	const prefix = new Uint32Array(sub.length);
	for (let i = 1, j = 0; i < sub.length; i++) {
		while (j > 0 && sub[i] !== sub[j]) j = prefix[j - 1] as number;
		if (sub[i] === sub[j]) j++;
		prefix[i] = j;
	}
	let n = 0;
	for (let i = 0, j = 0; i < s.length; i++) {
		while (j > 0 && s[i] !== sub[j]) j = prefix[j - 1] as number;
		if (s[i] === sub[j]) j++;
		if (j === sub.length) {
			n++;
			j = prefix[j - 1] as number;
		}
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
 * them all at once. Matching treats CRLF and LF as equal; only the matched span changes, so a lone
 * CR elsewhere in the file is copied as it was, and the replacement uses the file's line ending.
 * `edits` texts are byte strings (latin1).
 */
export function applyEdits(
	content: string,
	edits: { oldText: string; newText: string }[],
	lineEnding: string,
	path: string,
): string {
	const { text: normalized, offsets } = normalizeWithOffsets(content);
	const matched: Matched[] = [];
	edits.forEach((e, i) => {
		const old = normalizeToLF(e.oldText);
		if (old === "") {
			throw new FileTaskError("invalid_spec", `edits[${i}].old_text must not be empty in ${path}`);
		}
		const idx = normalized.indexOf(old);
		if (idx < 0) {
			throw new FileTaskError(
				"edit_no_match",
				`could not find edits[${i}] in ${path}; old_text must match exactly including whitespace and newlines`,
			);
		}
		const n = countMatches(normalized, old);
		if (n > 1) {
			throw new FileTaskError(
				"edit_ambiguous",
				`found ${n} occurrences of edits[${i}] in ${path}; add more context to make it unique`,
			);
		}
		const start = offsets[idx] as number;
		const end = offsets[idx + old.length] as number;
		const newText = normalizeToLF(e.newText).replaceAll("\n", lineEnding);
		matched.push({ index: i, start, length: end - start, newText });
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
