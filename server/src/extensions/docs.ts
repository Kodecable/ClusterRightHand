import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "../util/errors.ts";
import type { ApiReference } from "./api-reference.ts";
import { markdownDocs } from "./docs-source.ts";

/**
 * The documentation index behind `search_docs` and `read_doc` (doc/design/extensions.md "Documentation"):
 * the `doc/` Markdown tree of the running version plus the API reference rendered from the app's document.
 * Documents are split at headings into sections; search scores keywords against a section's heading (weighted)
 * and text, and `read_doc` pages a whole document or one section line by line.
 */

export interface DocSection {
	/** The heading text, without its `#` marks. */
	heading: string;
	/** The heading's anchor, as a link to this section would use. */
	anchor: string;
	/** 0-based line of the heading; `end` is exclusive. */
	start: number;
	end: number;
}

export interface DocDocument {
	path: string;
	title: string;
	lines: string[];
	sections: DocSection[];
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** The default page of `read_doc`, and the most it returns at once: like `read_file`. */
export const DOC_PAGE_LINES = 2_000;
/** The byte budget of one `read_doc` page; whole lines are kept. */
export const DOC_MAX_OUTPUT_BYTES = 50 * 1024;

/** A heading's anchor, in the form a Markdown link uses (`Built-in extensions` → `built-in-extensions`). */
export function headingSlug(text: string): string {
	return text
		.toLowerCase()
		.replace(/`([^`]*)`/g, "$1")
		.replace(/[*_~]/g, "")
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** A heading without the inline Markdown that a section lookup should ignore. */
function headingKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/`([^`]*)`/g, "$1")
		.replace(/[*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Splits one Markdown document at its headings; code fences do not open sections. */
export function parseDocument(path: string, markdown: string): DocDocument {
	const lines = markdown.split(/\r?\n/);
	const headings: { line: number; text: string }[] = [];
	let fenced = false;
	lines.forEach((line, index) => {
		if (FENCE.test(line)) {
			fenced = !fenced;
			return;
		}
		if (fenced) return;
		const match = HEADING.exec(line);
		if (match?.[2] !== undefined) headings.push({ line: index, text: match[2] });
	});
	const used = new Set<string>();
	const sections: DocSection[] = headings.map((heading, index) => {
		const base = headingSlug(heading.text) || "section";
		let anchor = base;
		for (let suffix = 1; used.has(anchor); suffix += 1) anchor = `${base}-${suffix}`;
		used.add(anchor);
		return {
			heading: heading.text,
			anchor,
			start: heading.line,
			end: headings[index + 1]?.line ?? lines.length,
		};
	});
	const title = headings.find((heading) => /^#\s/.test(lines[heading.line] ?? ""))?.text ?? path.replace(/\.md$/, "");
	return { path, title, lines, sections };
}

/** The documentation of this version: the repository (or bundled) tree, plus the API reference pages. */
export async function loadDocs(root: string, api: ApiReference | undefined): Promise<DocDocument[]> {
	const documents: DocDocument[] = [];
	for (const path of await markdownDocs(root)) {
		const segments = path.split("/");
		documents.push(parseDocument(path, await readFile(join(root, ...segments), "utf8")));
	}
	for (const [path, markdown] of api?.pages ?? []) documents.push(parseDocument(path, markdown));
	return documents.sort((left, right) => left.path.localeCompare(right.path));
}

function sectionText(document: DocDocument, section: DocSection): string {
	return document.lines.slice(section.start + 1, section.end).join("\n");
}

function tokensOf(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token !== "");
}

export interface DocSearchResult {
	path: string;
	/** The section's anchor, for `read_doc(path, section)`. */
	heading: string;
	headingText: string;
	snippet: string;
	score: number;
}

function snippetOf(text: string, tokens: readonly string[]): string {
	const lower = text.toLowerCase();
	let at = -1;
	for (const token of tokens) {
		const index = lower.indexOf(token);
		if (index >= 0 && (at < 0 || index < at)) at = index;
	}
	if (at < 0) return "";
	const from = Math.max(0, at - 80);
	const chunk = text
		.slice(from, from + 220)
		.replace(/\s+/g, " ")
		.trim();
	return `${from > 0 ? "…" : ""}${chunk}${from + 220 < text.length ? "…" : ""}`;
}

/** Keyword search over the headings (weighted) and text of every section, like `search_tools`. */
export function searchDocs(documents: readonly DocDocument[], query: string, limit: number): DocSearchResult[] {
	const tokens = tokensOf(query);
	if (tokens.length === 0) return [];
	const results: DocSearchResult[] = [];
	for (const document of documents) {
		for (const section of document.sections) {
			const heading = section.heading.toLowerCase();
			const anchor = section.anchor.toLowerCase();
			const words = new Set(heading.split(/[^a-z0-9]+/));
			const text = sectionText(document, section);
			const lowerText = text.toLowerCase();
			let score = 0;
			let matched = true;
			for (const token of tokens) {
				const inHeading = heading.includes(token) || anchor.includes(token);
				const inText = lowerText.includes(token);
				if (!inHeading && !inText) {
					matched = false;
					break;
				}
				if (inHeading) score += words.has(token) ? 20 : 10;
				if (inText) score += 1;
			}
			if (!matched) continue;
			const snippet = snippetOf(text, tokens) || snippetOf(section.heading, tokens);
			results.push({
				path: document.path,
				heading: section.anchor,
				headingText: section.heading,
				snippet,
				score,
			});
		}
	}
	results.sort(
		(left, right) =>
			right.score - left.score || left.path.localeCompare(right.path) || left.heading.localeCompare(right.heading),
	);
	return results.slice(0, limit);
}

function editDistance(left: string, right: string): number {
	const rows = left.length + 1;
	const columns = right.length + 1;
	const previous = Array.from({ length: columns }, (_, index) => index);
	for (let row = 1; row < rows; row += 1) {
		let diagonal = previous[0] as number;
		previous[0] = row;
		for (let column = 1; column < columns; column += 1) {
			const above = previous[column] as number;
			previous[column] = Math.min(
				(previous[column] as number) + 1,
				(previous[column - 1] as number) + 1,
				diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
			);
			diagonal = above;
		}
	}
	return previous[columns - 1] as number;
}

function closest(wanted: string, candidates: readonly string[], limit = 3): string[] {
	const key = wanted.toLowerCase();
	return [...candidates]
		.map((candidate) => ({ candidate, distance: editDistance(key, candidate.toLowerCase()) }))
		.sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
		.map((entry) => entry.candidate)
		.slice(0, limit);
}

export function findDocument(documents: readonly DocDocument[], path: string): DocDocument | undefined {
	const wanted = path
		.trim()
		.replace(/^\.?\/+/, "")
		.replace(/^doc\//i, "")
		.toLowerCase();
	if (wanted === "") return undefined;
	return documents.find(
		(document) => document.path.toLowerCase() === wanted || document.path.toLowerCase() === `${wanted}.md`,
	);
}

/** The known documents a mistyped path is close to, for the error message. */
export function closeDocumentPaths(documents: readonly DocDocument[], path: string): string[] {
	return closest(
		path.trim(),
		documents.map((document) => document.path),
	);
}

export function findSection(document: DocDocument, heading: string): DocSection | undefined {
	const wanted = heading.trim().replace(/^#/, "");
	const key = headingKey(wanted);
	const slug = headingSlug(wanted);
	return document.sections.find(
		(section) =>
			section.anchor.toLowerCase() === wanted.toLowerCase() ||
			section.anchor === slug ||
			headingKey(section.heading) === key,
	);
}

export function closeSectionHeadings(document: DocDocument, heading: string): string[] {
	return closest(
		heading,
		document.sections.map((section) => section.heading),
	);
}

export interface DocPage {
	output: string;
	note: string;
}

/**
 * Pages a whole document or one section, 1-based lines, whole lines only, and a note that gives the range
 * and the offset to continue. The section's heading line is part of the page.
 */
export function pageDocument(
	document: DocDocument,
	section: DocSection | undefined,
	offset: number,
	limit: number,
): DocPage {
	const start = section?.start ?? 0;
	const end = section?.end ?? document.lines.length;
	const total = end - start;
	const where = `${document.path}${section ? `#${section.anchor}` : ""}`;
	if (total === 0) return { output: "", note: `[docs, ${where}, the ${section ? "section" : "document"} is empty]` };
	const from = Math.max(1, offset);
	if (from > total) {
		throw new UserError(
			`offset ${from} is past the end of this ${section ? "section" : "document"} (${total} lines)`,
			"invalid_argument",
		);
	}
	const wanted = Math.min(Math.max(1, limit), DOC_PAGE_LINES);
	const kept: string[] = [];
	let bytes = 0;
	for (let index = from - 1; index < total && kept.length < wanted; index += 1) {
		const line = document.lines[start + index] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
		if (bytes + lineBytes > DOC_MAX_OUTPUT_BYTES) {
			if (kept.length === 0) {
				kept.push(
					Buffer.from(line, "utf8")
						.subarray(0, DOC_MAX_OUTPUT_BYTES)
						.toString("utf8")
						.replace(/\uFFFD$/, ""),
				);
			}
			break;
		}
		kept.push(line);
		bytes += lineBytes;
	}
	const to = from + kept.length - 1;
	const more = to < total;
	return {
		output: kept.join("\n"),
		note: more
			? `[docs, ${where}, lines ${from}-${to} of ${total}; use offset=${to + 1} to continue]`
			: `[docs, ${where}, lines ${from}-${to} of ${total} (end of ${section ? "section" : "document"})]`,
	};
}
