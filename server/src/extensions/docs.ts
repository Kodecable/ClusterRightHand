import { join } from "node:path";
import { UserError } from "../util/errors.ts";
import type { ApiReference } from "./api-reference.ts";
import { docFiles, readDocText } from "./docs-source.ts";
import { buildSearchIndex, type SearchIndex, searchIndexRecord, searchQueryTerms } from "./search-index.ts";

/**
 * The documentation index behind `search_docs` and `read_doc` (doc/design/extensions.md "Documentation"):
 * the `doc/` text tree of the running version plus the API reference rendered from the app's document.
 * Markdown documents are split at headings into sections; other text files are read whole. Search ranks
 * sections with MiniSearch over their heading, ancestor headings, path/anchor and own text, and `read_doc`
 * lists a directory, outlines a Markdown document, or pages one section or whole text file line by line.
 */

export interface DocSection {
	/** The heading text, without its `#` marks. */
	heading: string;
	/** The heading's anchor, as a link to this section would use. */
	anchor: string;
	/** The heading level, 1 for `#` through 6 for `######`. */
	level: number;
	/** 0-based line of the heading. */
	start: number;
	/** 0-based line after the section's own text; the next heading, or the end of the document. */
	bodyEnd: number;
	/** 0-based line after the section and its subsections; the next heading of the same or a higher level. */
	end: number;
	/** The headings from the top level down to this one, joined with ` > `, for search only. */
	headingPath: string;
}

export interface DocDocument {
	path: string;
	title: string;
	lines: string[];
	/** Empty for a non-Markdown text file, which has no sections and is read whole. */
	sections: DocSection[];
	/** Whether this document is Markdown and can be read by section. */
	markdown: boolean;
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

/** The last segment of a forward-slash documentation path. */
function fileName(path: string): string {
	return path.split("/").at(-1) ?? path;
}

/** Splits one Markdown document at its headings; code fences do not open sections. */
export function parseDocument(path: string, markdown: string): DocDocument {
	const lines = markdown.split(/\r?\n/);
	const headings: { line: number; text: string; level: number }[] = [];
	let fenced = false;
	lines.forEach((line, index) => {
		if (FENCE.test(line)) {
			fenced = !fenced;
			return;
		}
		if (fenced) return;
		const match = HEADING.exec(line);
		if (match?.[2] !== undefined) headings.push({ line: index, text: match[2], level: (match[1] ?? "#").length });
	});
	const endAt = headings.map(() => lines.length);
	const open: number[] = [];
	for (let index = headings.length - 1; index >= 0; index -= 1) {
		const level = headings[index]?.level ?? 1;
		while (open.length > 0 && (headings[open.at(-1) as number]?.level ?? 0) > level) open.pop();
		const boundary = open.at(-1);
		if (boundary !== undefined) endAt[index] = headings[boundary]?.line ?? lines.length;
		open.push(index);
	}
	const used = new Set<string>();
	const ancestors: { level: number; text: string }[] = [];
	const sections: DocSection[] = headings.map((heading, index) => {
		const base = headingSlug(heading.text) || "section";
		let anchor = base;
		for (let suffix = 1; used.has(anchor); suffix += 1) anchor = `${base}-${suffix}`;
		used.add(anchor);
		while (ancestors.length > 0 && (ancestors.at(-1)?.level ?? 0) >= heading.level) ancestors.pop();
		const headingPath = [...ancestors.map((ancestor) => ancestor.text), heading.text].join(" > ");
		ancestors.push({ level: heading.level, text: heading.text });
		return {
			heading: heading.text,
			anchor,
			level: heading.level,
			start: heading.line,
			bodyEnd: headings[index + 1]?.line ?? lines.length,
			end: endAt[index] ?? lines.length,
			headingPath,
		};
	});
	const title = headings.find((heading) => heading.level === 1)?.text ?? headings[0]?.text ?? fileName(path);
	return { path, title, lines, sections, markdown: true };
}

/** A non-Markdown text file: one whole document with no sections. The bundle also carries these. */
export function textDocument(path: string, text: string): DocDocument {
	return { path, title: fileName(path), lines: text.split(/\r?\n/), sections: [], markdown: false };
}

/** The documentation of this version: the repository (or bundled) tree, plus the API reference pages. */
export async function loadDocs(root: string, api: ApiReference | undefined): Promise<DocDocument[]> {
	const documents: DocDocument[] = [];
	for (const path of await docFiles(root)) {
		const text = await readDocText(join(root, ...path.split("/")));
		if (text === undefined) continue;
		documents.push(path.toLowerCase().endsWith(".md") ? parseDocument(path, text) : textDocument(path, text));
	}
	for (const [path, markdown] of api?.pages ?? []) documents.push(parseDocument(path, markdown));
	return documents.sort((left, right) => left.path.localeCompare(right.path));
}

/** The section's own text, without its subsections. */
function sectionText(document: DocDocument, section: DocSection): string {
	return document.lines
		.slice(section.start + 1, section.bodyEnd)
		.join("\n")
		.trim();
}

/** One indexed section: the fields MiniSearch ranks and the text a snippet is taken from. */
interface DocSearchRecord {
	id: string;
	path: string;
	anchor: string;
	heading: string;
	headingPath: string;
	text: string;
}

const DOC_SEARCH_FIELDS = ["heading", "headingPath", "path", "anchor", "text"] as const;
const DOC_SEARCH_BOOST = { heading: 3, path: 2, anchor: 2, text: 1, headingPath: 0.5 } as const;

/** The index of a document list, built once when the docs load and reused by every search. */
const docSearchIndexes = new WeakMap<readonly DocDocument[], SearchIndex<DocSearchRecord>>();

function searchIndexFor(documents: readonly DocDocument[]): SearchIndex<DocSearchRecord> {
	let search = docSearchIndexes.get(documents);
	if (!search) {
		const records: DocSearchRecord[] = [];
		documents.forEach((document, documentIndex) => {
			if (!document.markdown) {
				const text = document.lines.join("\n").trim();
				if (text !== "") {
					records.push({
						id: `${documentIndex}:text`,
						path: document.path,
						anchor: "",
						heading: document.title,
						headingPath: "",
						text,
					});
				}
				return;
			}
			document.sections.forEach((section, sectionIndex) => {
				const text = sectionText(document, section);
				// A chapter that only holds subheadings has no text of its own; its subsections carry its heading
				// through the headingPath field instead, so it does not rank as an empty result.
				if (text === "") return;
				records.push({
					id: `${documentIndex}:${sectionIndex}`,
					path: document.path,
					anchor: section.anchor,
					heading: section.heading,
					headingPath: section.headingPath,
					text,
				});
			});
		});
		search = buildSearchIndex(records, {
			fields: DOC_SEARCH_FIELDS,
			storeFields: ["path", "anchor", "heading"],
			boost: DOC_SEARCH_BOOST,
		});
		docSearchIndexes.set(documents, search);
	}
	return search;
}

/** Builds the index when the docs load, so the first search does not pay for it. */
export function prepareDocsSearch(documents: readonly DocDocument[]): void {
	searchIndexFor(documents);
}

export interface DocSearchResult {
	path: string;
	/** The section's anchor, for `read_doc(path, section)`; empty for a non-Markdown file. */
	heading: string;
	headingText: string;
	snippet: string;
	score: number;
}

/** The longest snippet taken when no matched term can be located in the text. */
const SNIPPET_FALLBACK = 200;

/**
 * A snippet around the earliest matched document term. Non-Markdown files and typo or stem matches still
 * yield their text: when no term can be located, the start of the section is shown instead of the heading.
 */
function snippetOf(text: string, terms: readonly string[]): string {
	const lower = text.toLowerCase();
	let at = -1;
	for (const term of terms) {
		if (term === "") continue;
		const index = lower.indexOf(term.toLowerCase());
		if (index >= 0 && (at < 0 || index < at)) at = index;
	}
	if (at < 0) {
		const chunk = text.slice(0, SNIPPET_FALLBACK).replace(/\s+/g, " ").trim();
		return `${chunk}${text.length > SNIPPET_FALLBACK ? "…" : ""}`;
	}
	const from = Math.max(0, at - 80);
	const chunk = text
		.slice(from, from + 220)
		.replace(/\s+/g, " ")
		.trim();
	return `${from > 0 ? "…" : ""}${chunk}${from + 220 < text.length ? "…" : ""}`;
}

/** BM25 search over the heading (weighted), ancestor headings, path/anchor and own text of every section. */
export function searchDocs(documents: readonly DocDocument[], query: string, limit: number): DocSearchResult[] {
	const terms = searchQueryTerms(query);
	if (terms.length === 0) return [];
	const search = searchIndexFor(documents);
	const results: DocSearchResult[] = [];
	for (const result of search.index.search(query)) {
		const record = searchIndexRecord(search, result);
		if (!record) continue;
		results.push({
			path: record.path,
			heading: record.anchor,
			headingText: record.heading,
			snippet: snippetOf(record.text, result.terms),
			score: result.score,
		});
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

/** A documentation path without a leading `/`, `./` or `doc/`, and without trailing slashes. */
export function normalizeDocPath(path: string): string {
	return path
		.trim()
		.replaceAll("\\", "/")
		.replace(/^\/+/, "")
		.replace(/^(?:\.\/)+/, "")
		.replace(/^doc(?:\/|$)/i, "")
		.replace(/\/+$/, "");
}

export function findDocument(documents: readonly DocDocument[], path: string): DocDocument | undefined {
	const wanted = normalizeDocPath(path).toLowerCase();
	if (wanted === "") return undefined;
	return documents.find(
		(document) => document.path.toLowerCase() === wanted || document.path.toLowerCase() === `${wanted}.md`,
	);
}

/** Every directory that holds a loaded document, without a trailing slash. */
function docDirectories(documents: readonly DocDocument[]): string[] {
	const directories = new Set<string>();
	for (const document of documents) {
		const segments = document.path.split("/");
		segments.pop();
		let current = "";
		for (const segment of segments) {
			current = current === "" ? segment : `${current}/${segment}`;
			directories.add(current);
		}
	}
	return [...directories].sort();
}

/** A directory path (with or without a trailing slash), or `""` for the documentation root. */
export function findDirectory(documents: readonly DocDocument[], path: string): string | undefined {
	const wanted = normalizeDocPath(path);
	if (wanted === "") return "";
	return docDirectories(documents).find((directory) => directory.toLowerCase() === wanted.toLowerCase());
}

export interface DocDirectoryEntries {
	/** Immediate subdirectories, as paths without a trailing slash, sorted. */
	directories: string[];
	/** Immediate documents, sorted by path. */
	documents: DocDocument[];
}

/** The immediate children of a directory, as `read_doc` lists them. */
export function listDirectory(documents: readonly DocDocument[], directory: string): DocDirectoryEntries {
	const prefix = directory === "" ? "" : `${directory}/`;
	const directories = new Set<string>();
	const found: DocDocument[] = [];
	for (const document of documents) {
		if (!document.path.startsWith(prefix)) continue;
		const rest = document.path.slice(prefix.length);
		if (rest === "") continue;
		const slash = rest.indexOf("/");
		if (slash < 0) {
			found.push(document);
		} else {
			directories.add(`${prefix}${rest.slice(0, slash)}`);
		}
	}
	return {
		directories: [...directories].sort(),
		documents: found.sort((left, right) => left.path.localeCompare(right.path)),
	};
}

/** The outline of a Markdown document: each heading indented by level, with its anchor and line count. */
export function outlineLines(document: DocDocument): string[] {
	return document.sections.map((section) => {
		const count = section.end - section.start;
		return `${"  ".repeat(section.level - 1)}${"#".repeat(section.level)} ${section.heading} [${section.anchor}] — ${count} ${
			count === 1 ? "line" : "lines"
		}`;
	});
}

/** The known documents and directories a mistyped path is close to, for the error message. */
export function closeDocumentPaths(documents: readonly DocDocument[], path: string): string[] {
	const directories = docDirectories(documents);
	const directorySet = new Set(directories);
	return closest(normalizeDocPath(path), [...documents.map((document) => document.path), ...directories]).map(
		(match) => (directorySet.has(match) ? `${match}/` : match),
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
 * Pages a list of lines, 1-based, whole lines only, and a note that gives the range and the offset to
 * continue. Documents, sections, directory listings and outlines share the same page size and byte budget.
 */
export function pageLines(
	lines: readonly string[],
	where: string,
	kind: string,
	offset: number,
	limit: number,
): DocPage {
	const total = lines.length;
	if (total === 0) return { output: "", note: `[docs, ${where}, the ${kind} is empty]` };
	const from = Math.max(1, offset);
	if (from > total) {
		throw new UserError(`offset ${from} is past the end of this ${kind} (${total} lines)`, "invalid_argument");
	}
	const wanted = Math.min(Math.max(1, limit), DOC_PAGE_LINES);
	const kept: string[] = [];
	let bytes = 0;
	for (let index = from - 1; index < total && kept.length < wanted; index += 1) {
		const line = lines[index] ?? "";
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
			: `[docs, ${where}, lines ${from}-${to} of ${total} (end of ${kind})]`,
	};
}

/**
 * Pages a whole document or one section, including its subsections, 1-based lines, whole lines only, and a
 * note that gives the range and the offset to continue. The section's heading line is part of the page.
 */
export function pageDocument(
	document: DocDocument,
	section: DocSection | undefined,
	offset: number,
	limit: number,
): DocPage {
	const lines = section ? document.lines.slice(section.start, section.end) : document.lines;
	const where = section ? `${document.path}#${section.anchor}` : document.path;
	return pageLines(lines, where, section ? "section" : "document", offset, limit);
}
