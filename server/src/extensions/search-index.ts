import MiniSearch, { type Options as MiniSearchOptions, type SearchResult } from "minisearch";
import { stemmer } from "stemmer";

/**
 * The lexical search behind `search_docs` and `search_tools` (doc/design/extensions.md "Documentation" and
 * "Built-in extensions"): a MiniSearch BM25 index, so any query term may match and rarer terms rank higher.
 * Both indexes share the tokenizer, term processing and query options here; still no embeddings or model call.
 */

/** The small English stopword list `search_docs` and `search_tools` ignore, in queries and in documents. */
const STOPWORDS: ReadonlySet<string> = new Set([
	"a",
	"about",
	"after",
	"all",
	"also",
	"am",
	"an",
	"and",
	"any",
	"are",
	"as",
	"at",
	"be",
	"because",
	"been",
	"before",
	"being",
	"between",
	"both",
	"but",
	"by",
	"can",
	"could",
	"did",
	"do",
	"does",
	"doing",
	"during",
	"each",
	"few",
	"for",
	"from",
	"further",
	"had",
	"has",
	"have",
	"having",
	"he",
	"her",
	"here",
	"hers",
	"herself",
	"him",
	"himself",
	"his",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"itself",
	"just",
	"me",
	"more",
	"most",
	"my",
	"myself",
	"no",
	"nor",
	"not",
	"now",
	"of",
	"off",
	"on",
	"once",
	"only",
	"or",
	"other",
	"our",
	"ours",
	"ourselves",
	"out",
	"over",
	"own",
	"same",
	"she",
	"should",
	"so",
	"some",
	"such",
	"than",
	"that",
	"the",
	"their",
	"theirs",
	"them",
	"themselves",
	"then",
	"there",
	"these",
	"they",
	"this",
	"those",
	"through",
	"to",
	"too",
	"under",
	"until",
	"up",
	"very",
	"was",
	"we",
	"were",
	"what",
	"when",
	"where",
	"which",
	"while",
	"who",
	"whom",
	"why",
	"will",
	"with",
	"would",
	"you",
	"your",
	"yours",
	"yourself",
	"yourselves",
]);

/**
 * A run of letters and numbers that keeps `_` and `-` inside it, so an identifier stays one candidate
 * (`api_request`, `node-groups`); everything else separates candidates, including CJK punctuation.
 */
const WORD = /[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/gu;
/** The camelCase and digit boundaries of an identifier (`nodeIds` → node, Ids; `NodeGroup` → Node, Group). */
const CAMEL_PARTS = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\p{N}+/gu;

/** The lowercased parts of an identifier, across its camelCase and `_`/`-` separators. */
function identifierParts(identifier: string): string[] {
	const parts: string[] = [];
	for (const part of identifier.match(CAMEL_PARTS) ?? []) {
		for (const piece of part.toLowerCase().split(/[_-]+/u)) {
			if (piece.length > 1) parts.push(piece);
		}
	}
	return parts;
}

/**
 * Splits text into lowercased terms, also emitting the parts of identifiers: `api_request` → `api_request`,
 * `api`, `request`; `node-groups` → `node-groups`, `node`, `groups`; `nodeIds` → `nodeids`, `node`, `ids`.
 * A run of CJK characters is one term; there is no segmentation by dictionary.
 */
export function searchTokens(text: string): string[] {
	const tokens: string[] = [];
	for (const match of text.matchAll(WORD)) {
		const identifier = match[0];
		const lower = identifier.toLowerCase();
		tokens.push(lower);
		for (const part of new Set(identifierParts(identifier))) {
			if (part !== lower) tokens.push(part);
		}
	}
	return tokens;
}

/** Drops a stopword and stems an English (ASCII letters only) term with the Porter stemmer. */
export function processSearchTerm(term: string): string | undefined {
	if (term === "" || STOPWORDS.has(term)) return undefined;
	if (!/^[a-z]+$/.test(term)) return term;
	const stem = stemmer(term);
	return stem === "" || STOPWORDS.has(stem) ? undefined : stem;
}

/** The processed terms a query searches for, for snippets and for the "nothing but stopwords" case. */
export function searchQueryTerms(query: string): string[] {
	const terms = new Set<string>();
	for (const token of searchTokens(query)) {
		const term = processSearchTerm(token);
		if (term !== undefined) terms.add(term);
	}
	return [...terms];
}

/** The fields to index and boost, and the fields to store on results. */
export interface SearchIndexOptions {
	fields: readonly string[];
	storeFields?: readonly string[];
	boost: Readonly<Record<string, number>>;
}

/** An index and its documents by id, so result ids can be turned back into sections or tools. */
export interface SearchIndex<T extends { id: string }> {
	index: MiniSearch<T>;
	records: Map<string, T>;
}

/** Builds one BM25 index whose query keeps OR matching, prefixes, small fuzziness and the field boosts. */
export function buildSearchIndex<T extends { id: string }>(
	documents: readonly T[],
	options: SearchIndexOptions,
): SearchIndex<T> {
	const configuration: MiniSearchOptions<T> = {
		fields: [...options.fields],
		storeFields: [...(options.storeFields ?? [])],
		tokenize: searchTokens,
		processTerm: processSearchTerm,
		searchOptions: {
			boost: { ...options.boost },
			prefix: true,
			// A fraction of the term length: one edit for a five-letter term, so `grup` still finds `group`.
			fuzzy: 0.2,
			combineWith: "OR",
		},
	};
	const index = new MiniSearch<T>(configuration);
	index.addAll(documents);
	return { index, records: new Map(documents.map((document) => [document.id, document])) };
}

/** The record of one search result, from its id; MiniSearch's ids are the documents' own. */
export function searchIndexRecord<T extends { id: string }>(
	search: SearchIndex<T>,
	result: SearchResult,
): T | undefined {
	return search.records.get(String(result.id));
}
