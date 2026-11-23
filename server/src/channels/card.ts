import { escapeMarkdown, inlineCode } from "./messages.ts";

/**
 * The one structured chat card and its two renderers (doc/design/channels.md "Approvals"): Telegram takes
 * Markdown, Satori takes plain text. A card is data, never a Markdown string converted on the way out, so a
 * value a user or a model supplies cannot turn into formatting on either surface.
 *
 * Line order is fixed: title (and its privileged suffix), meta, risk with its reason, detail, then a blank
 * line and the hints. The Telegram lines are joined by a hard line break (`TELEGRAM_LINE_BREAK`); if Telegram
 * ever stops accepting a backslash hard break, swapping that one constant for "\n\n" changes every card.
 */

export type ChatCardRisk = "low" | "medium" | "high";

export interface ChatCard {
	/** Localized: "Approval needed", "Signature needed" or "Token quota used up". */
	title: string;
	/** " · privileged" after the title. */
	privileged: boolean;
	/** The grey info line: the nodes, the quota's session title, and the source without a thread. */
	meta?: string;
	/** The job context line, only for an approval that belongs to a job. */
	job?: string;
	risk?: ChatCardRisk;
	/** Auto Review's reason, after the risk: "🟡 Medium risk · <reason>". */
	reason?: string;
	/** The one-line detail: the command, the file operation and path, the request or the tool. */
	detail?: string;
	/** A terminal's screen excerpt, shown as its own labelled block (pty.io approvals). */
	screen?: string;
	/** Command hints, "label: /command args" style. */
	hints: string[];
}

/** The localized words the renderers need; the builders supply the rest of each line. */
export interface CardLabels {
	privilegedSuffix: string;
	/** "Low risk", "Medium risk" or "High risk", localized. */
	riskLevel: (risk: ChatCardRisk) => string;
	/** The label in front of a terminal screen excerpt. */
	screen: (text: string) => string;
}

export type CardFormat = "markdown" | "plain";

/** A hard line break in CommonMark: a backslash at the end of a line. */
export const TELEGRAM_LINE_BREAK = "\\\n";

const RISK_EMOJI: Record<ChatCardRisk, string> = { low: "🟢", medium: "🟡", high: "🔴" };

/**
 * A hint is a fixed command or a link, with any user value escaped by the builder's line; leaving the
 * characters that make up a URL and a command unescaped keeps a `https://…` link clickable and a
 * `/command` readable. Everything Markdown or Telegram's rich parser can turn into formatting stays escaped.
 */
function escapeHint(hint: string): string {
	return escapeMarkdown(hint).replace(/\\([/.:-])/g, "$1");
}

/** The card's lines without any surface formatting, in the order every card uses. */
function cardLines(
	card: ChatCard,
	labels: CardLabels,
): { body: { text: string; kind: "title" | "value" | "detail" }[]; hints: string[] } {
	const body: { text: string; kind: "title" | "value" | "detail" }[] = [];
	body.push({ text: card.title, kind: "title" });
	if (card.meta !== undefined && card.meta !== "") body.push({ text: card.meta, kind: "value" });
	if (card.job !== undefined && card.job !== "") body.push({ text: card.job, kind: "value" });
	if (card.risk !== undefined) {
		const reason = card.reason !== undefined && card.reason !== "" ? ` · ${card.reason}` : "";
		body.push({ text: `${RISK_EMOJI[card.risk]} ${labels.riskLevel(card.risk)}${reason}`, kind: "value" });
	}
	if (card.detail !== undefined && card.detail !== "") body.push({ text: card.detail, kind: "detail" });
	if (card.screen !== undefined && card.screen !== "") body.push({ text: labels.screen(card.screen), kind: "value" });
	return { body, hints: card.hints.filter((hint) => hint !== "") };
}

/** Telegram: bold title, escaped values, the detail as one inline code span and hard line breaks. */
function renderMarkdownCard(card: ChatCard, labels: CardLabels): string {
	const lines = cardLines(card, labels);
	const body = lines.body.map((line) => {
		if (line.kind === "title") {
			const suffix = card.privileged ? labels.privilegedSuffix : "";
			return `**${line.text}**${suffix}`;
		}
		if (line.kind === "detail") return inlineCode(line.text);
		return escapeMarkdown(line.text);
	});
	const hints = lines.hints.map((hint) => escapeHint(hint));
	if (hints.length === 0) return body.join(TELEGRAM_LINE_BREAK);
	return `${body.join(TELEGRAM_LINE_BREAK)}\n\n${hints.join(TELEGRAM_LINE_BREAK)}`;
}

/** Satori: plain text, no Markdown syntax at all, one newline between lines and a blank line before hints. */
function renderPlainCard(card: ChatCard, labels: CardLabels): string {
	const lines = cardLines(card, labels);
	const body = lines.body.map((line) =>
		line.kind === "title" && card.privileged ? `${line.text}${labels.privilegedSuffix}` : line.text,
	);
	return [...body, ...(lines.hints.length > 0 ? ["", ...lines.hints] : [])].join("\n");
}

/** Renders a card for the surface that will send it. */
export function renderCard(card: ChatCard, labels: CardLabels, format: CardFormat): string {
	return format === "markdown" ? renderMarkdownCard(card, labels) : renderPlainCard(card, labels);
}

/** One standalone line (a decision result): escaped for Markdown, literal on a plain surface. */
export function renderCardLine(line: string, format: CardFormat): string {
	return format === "markdown" ? escapeMarkdown(line) : line;
}
