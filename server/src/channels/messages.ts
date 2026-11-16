import type { ApprovalRequest, QuotaStatus, TaskAction, ThinkingLevel, UserSettingsLocale } from "@crh/api";
import { formatList, matchLocale, quotaStatus } from "@crh/api";
import type { CardLabels, ChatCard } from "./card.ts";

/**
 * The chat bot's fixed texts (doc/design/channels.md "Messages"), in English and Chinese. Both catalogues
 * are typed with the same interface, so a missing or extra key is a type error. Messages with values are
 * functions; model output is never translated.
 *
 * A card (an approval, a signature wait or a quota wait) is data: the builders below return a `ChatCard`
 * with raw values, and the renderer for the platform it goes to escapes or unwraps them. Telegram takes
 * Markdown, Satori plain text, so neither surface converts the other's format.
 *
 * Text rules, shared with the WebUI (web/src/lib/i18n.tsx):
 * 1. One message per sentence or line, with values as parameters: `Nodes: ${list}` / `节点：${list}`. Never
 *    build a line from separately translated fragments, and never add punctuation or spaces next to a
 *    translation in code: each catalogue owns its colon, spacing and word order (a full-width `：` takes no
 *    space after it).
 * 2. Lists go through `Intl.ListFormat(locale, { type: "conjunction", style: "narrow" })`, which gives
 *    `a, b, c` and `a、b、c`; never a hard-coded `join`.
 * 3. Plurals and counts are worded inside the message function, not assembled around it.
 * 4. Code may only put language-neutral layout between whole messages: the ` · ` separator and line breaks.
 * 5. Chinese texts use full-width punctuation (：，（）“”、) and keep the spacing between Chinese and Latin text
 *    the way the catalogue writes it.
 */

export type BotLocale = UserSettingsLocale;

/**
 * Escapes every ASCII punctuation character of a value interpolated into a framework text. CommonMark lets a
 * backslash escape any ASCII punctuation, and Telegram's rich Markdown parses more than the classic set:
 * `$formula$`, `==mark==`, `||spoiler||`, `^`, footnote markers and table pipes all start with punctuation.
 */
export function escapeMarkdown(text: string): string {
	return text.replace(/\r?\n/g, " ").replace(/([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "\\$1");
}

/**
 * An inline code span for a value a reader should see literally, with a fence longer than the longest
 * backtick run inside it. Padding spaces keep a value that starts or ends with a backtick inside the span.
 */
export function inlineCode(text: string): string {
	const value = text.replace(/[\r\n]+/g, " ") || " ";
	let longest = 0;
	for (const run of value.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
	const fence = "`".repeat(longest + 1);
	const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
	return `${fence}${pad}${value}${pad}${fence}`;
}

/** A byte count the way the WebUI shows it: the largest binary unit, such as "32 MiB". */
export function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let amount = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
	let unit = 0;
	while (amount >= 1024 && unit < units.length - 1) {
		amount /= 1024;
		unit += 1;
	}
	return `${Number(amount.toFixed(unit === 0 ? 0 : 1))} ${units[unit]}`;
}

export interface BotCommandMenuEntry {
	command: string;
	description: string;
}

/** The `/help` list and the Telegram command menu share these commands. */
type ApprovalFileOperation = Extract<TaskAction, { type: "file" }>["operation"];

/** A token count the way every chat line shows it: the reader's locale's grouping, never a raw negative. */
function tokenCount(value: number, locale: "en" | "zh-CN"): string {
	return new Intl.NumberFormat(locale).format(value);
}

/** The one quota line: used first and never a negative remaining (doc/design/channels.md "Approvals"). */
function quotaLine(status: QuotaStatus, locale: "en" | "zh-CN"): string {
	if (status.kind === "exhausted") {
		return locale === "zh-CN"
			? `已用完，超出 ${tokenCount(status.over, locale)}`
			: `Used up, over by ${tokenCount(status.over, locale)}`;
	}
	const used = tokenCount(status.used, locale);
	if (status.kind === "unlimited") return locale === "zh-CN" ? `已用 ${used} · 不限` : `Used ${used} · Unlimited`;
	const remaining = tokenCount(status.remaining, locale);
	return locale === "zh-CN" ? `已用 ${used} · 剩余 ${remaining}` : `Used ${used} · ${remaining} left`;
}

/**
 * The localized words a card is built from. The layout itself lives in `card.ts`, so Telegram and Satori
 * cannot drift apart while one of the catalogues changes; the WebUI has the same words in its own catalogue.
 */
interface CardText extends CardLabels {
	approvalTitle: string;
	signatureTitle: string;
	quotaTitle: string;
	untitledSession: string;
	/** The one source line, used only when the default notification account routed the card. */
	source: {
		session: (title: string) => string;
		apiToken: (name: string) => string;
		user: (username: string) => string;
		system: () => string;
		autoReview: () => string;
		schedule: (name: string) => string;
	};
	actions: {
		file: (operation: ApprovalFileOperation, path: string, lines: { start: number; end: number } | undefined) => string;
	};
	/** `moreNodes` is the number the server left out; every name is raw and escaped by the renderer. */
	nodes: (names: readonly string[], moreNodes: number | undefined) => string;
	rejectWithButtons: (id: string) => string;
	approveHint: (id: string) => string;
	rejectHint: (id: string) => string;
	signatureHint: (link: string | null) => string;
	quotaDetail: (status: QuotaStatus) => string;
	quotaContinue: string;
	quotaStop: string;
	approvedResult: (by: string) => string;
	rejectedResult: (by: string, reason: string | null) => string;
	expired: string;
	/** The name Auto Review's decisions read as. */
	autoReview: string;
}

const EN_CARD: CardText = {
	approvalTitle: "Approval needed",
	signatureTitle: "Signature needed",
	quotaTitle: "Token quota used up",
	untitledSession: "New session",
	source: {
		session: (title) => `Source: Session ${title}`,
		apiToken: (name) => `Source: API token ${name}`,
		user: (username) => `Source: User ${username}`,
		system: () => "Source: System",
		autoReview: () => "Source: Auto Review",
		schedule: (name) => `Source: Schedule ${name}`,
	},
	actions: {
		file: (operation, path, lines) =>
			`${{ read: "Read file", write: "Write file", push: "Push file", pull: "Pull file", edit: "Edit file", stat: "Stat file", list: "List directory" }[operation]} ${path}${lines ? ` (lines ${lines.start}-${lines.end})` : ""}`,
	},
	nodes: (names, moreNodes) => {
		const list = formatList("en", names);
		return moreNodes ? `Nodes: ${list} and ${moreNodes} more` : `Nodes: ${list}`;
	},
	privilegedSuffix: " · privileged",
	riskLevel: (risk) => ({ low: "Low risk", medium: "Medium risk", high: "High risk" })[risk],
	rejectWithButtons: (id) => `Reject with a reason: /reject ${id} reason`,
	approveHint: (id) => `/approve ${id}`,
	rejectHint: (id) => `/reject ${id} [reason]`,
	signatureHint: (link) => `Sign in the WebUI${link ? `: ${link}` : ""}`,
	quotaDetail: (status) => quotaLine(status, "en"),
	quotaContinue: "Continue: /quota add <tokens>",
	quotaStop: "End this turn: /quota stop",
	approvedResult: (by) => `✅ Approved · by ${oneLine(by)}`,
	rejectedResult: (by, reason) => `❌ Rejected · by ${oneLine(by)}${reason ? `: ${oneLine(reason)}` : ""}`,
	expired: "Expired",
	autoReview: "Auto Review",
};

const ZH_CARD: CardText = {
	approvalTitle: "需要你的审批",
	signatureTitle: "需要你的签名",
	quotaTitle: "令牌配额已用完",
	untitledSession: "新会话",
	source: {
		session: (title) => `请求源：会话 ${title}`,
		apiToken: (name) => `请求源：API 令牌 ${name}`,
		user: (username) => `请求源：用户 ${username}`,
		system: () => "请求源：系统",
		autoReview: () => "请求源：Auto Review",
		schedule: (name) => `请求源：计划任务 ${name}`,
	},
	actions: {
		file: (operation, path, lines) =>
			`${{ read: "读取文件", write: "写入文件", push: "推送文件", pull: "拉取文件", edit: "编辑文件", stat: "查看文件", list: "列出目录" }[operation]} ${path}${lines ? `（第 ${lines.start}-${lines.end} 行）` : ""}`,
	},
	nodes: (names, moreNodes) => {
		const list = formatList("zh-CN", names);
		return moreNodes ? `节点：${list} 等 ${moreNodes} 个` : `节点：${list}`;
	},
	privilegedSuffix: " · 特权",
	riskLevel: (risk) => ({ low: "低风险", medium: "中风险", high: "高风险" })[risk],
	rejectWithButtons: (id) => `拒绝并说明原因：/reject ${id} 原因`,
	approveHint: (id) => `/approve ${id}`,
	rejectHint: (id) => `/reject ${id} [原因]`,
	signatureHint: (link) => `在 WebUI 中签名${link ? `：${link}` : ""}`,
	quotaDetail: (status) => quotaLine(status, "zh-CN"),
	quotaContinue: "继续：/quota add <tokens>",
	quotaStop: "结束本回合：/quota stop",
	approvedResult: (by) => `✅ 已批准 · 由 ${oneLine(by)}`,
	rejectedResult: (by, reason) => `❌ 已拒绝 · 由 ${oneLine(by)}${reason ? `：${oneLine(reason)}` : ""}`,
	expired: "已失效",
	autoReview: "Auto Review",
};

/** A value stays on one line: a path or title from a model must not split a card's line. */
function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

/** The action's one-line detail, localized only where it has a verb (a file operation). */
function actionDetail(action: TaskAction, labels: CardText): string {
	switch (action.type) {
		case "exec":
			return oneLine(action.command);
		case "file":
			return oneLine(labels.actions.file(action.operation, action.path, action.lines));
		case "api_request":
			return oneLine(`${action.method} ${action.path}`);
		case "extension_tool":
			return oneLine(`${action.extension}/${action.tool}`);
	}
}

function sourceText(request: ApprovalRequest, labels: CardText): string {
	const source = request.source;
	switch (source.type) {
		case "session":
			return labels.source.session(oneLine(source.title) || labels.untitledSession);
		case "api_token":
			return labels.source.apiToken(oneLine(source.name));
		case "user":
			return labels.source.user(oneLine(source.username));
		case "system":
			return labels.source.system();
		case "auto_review":
			return labels.source.autoReview();
		case "schedule":
			return labels.source.schedule(oneLine(source.name));
	}
}

/** The nodes and, only when a default notification account routed the card, where the request came from. */
function metaText(request: ApprovalRequest, withSource: boolean, labels: CardText): string | undefined {
	const parts: string[] = [];
	if (request.nodes !== undefined && request.nodes.length > 0)
		parts.push(labels.nodes(request.nodes.map(oneLine), request.moreNodes));
	if (withSource) parts.push(sourceText(request, labels));
	return parts.length === 0 ? undefined : parts.join(" · ");
}

function approvalCardFor(
	request: ApprovalRequest,
	options: { withButtons: boolean; withSource: boolean },
	labels: CardText,
): ChatCard {
	const meta = metaText(request, options.withSource, labels);
	const card: ChatCard = {
		title: labels.approvalTitle,
		privileged: request.privileged,
		detail: actionDetail(request.action, labels),
		hints: options.withButtons
			? [labels.rejectWithButtons(request.id)]
			: [labels.approveHint(request.id), labels.rejectHint(request.id)],
	};
	if (meta !== undefined) card.meta = meta;
	if (request.review !== undefined) {
		card.risk = request.review.risk;
		card.reason = oneLine(request.review.reason);
	}
	return card;
}

/** A card for a task or task group waiting for the user's signature; its only hint is the WebUI link. */
function signatureCardFor(
	request: ApprovalRequest,
	link: string | null,
	options: { withSource: boolean },
	labels: CardText,
): ChatCard {
	const meta = metaText(request, options.withSource, labels);
	const card: ChatCard = {
		title: labels.signatureTitle,
		privileged: request.privileged,
		detail: actionDetail(request.action, labels),
		hints: [labels.signatureHint(link)],
	};
	if (meta !== undefined) card.meta = meta;
	if (request.review !== undefined) {
		card.risk = request.review.risk;
		card.reason = oneLine(request.review.reason);
	}
	return card;
}

/** The quota card: the session's title as meta, its usage as detail, and how to go on or end the turn. */
function quotaCardFor(title: string, status: QuotaStatus, labels: CardText): ChatCard {
	return {
		title: labels.quotaTitle,
		privileged: false,
		meta: title.trim() === "" ? labels.untitledSession : oneLine(title),
		detail: labels.quotaDetail(status),
		hints: [labels.quotaContinue, labels.quotaStop],
	};
}

export interface BotMessages {
	unsupported: string;
	filesNotSent: string;
	linkHelp: string;
	noSessions: string;
	unknownCommand: (name: string) => string;
	couldNotSaveFile: (problem: string) => string;
	/** A file the user's library single-file limit refuses; the limit is already formatted. */
	fileTooLarge: (limit: string) => string;
	couldNotSendMessage: (problem: string) => string;
	noDefaultModel: string;
	couldNotStartSession: (problem: string) => string;
	previousArchived: string;
	previousUnavailable: string;
	newSessionStarted: (link: string | null) => string;
	linkMissingCode: string;
	linkInvalidCode: string;
	accountNotActive: string;
	linked: string;
	alreadyLinked: string;
	unlinked: string;
	newSessionTitle: string;
	sessionsTitle: (page: number, pages: number) => string;
	sessionsTitleSingle: string;
	previousPage: string;
	nextPage: string;
	openSession: string;
	/** A hint under a page of numbered choices: how to pick one and how to change the page. */
	choiceHint: (command: string, page: number, pages: number) => string;
	/** A short refusal for a number or id that is not in the current list. */
	invalidChoice: (command: string) => string;
	sessionSwitched: (title: string) => string;
	extensionSet: (name: string, enabled: boolean) => string;
	thinkingHint: string;
	rulesHint: string;
	openSessionLink: (link: string) => string;
	noRunningSession: string;
	stopped: string;
	couldNotStop: (problem: string) => string;
	noSessionInChat: string;
	noSessionYet: string;
	quotaAddUsage: string;
	quotaAdded: (tokens: number) => string;
	quotaEnded: string;
	noQuota: string;
	quotaUsedUp: (over: number, used: number) => string;
	quotaRemaining: (used: number, remaining: number) => string;
	decideUsage: (name: string, withReason: boolean) => string;
	noWaitingApproval: string;
	approvalNoLongerWaiting: string;
	/** The localized words of every card (title, labels, result lines). */
	card: CardText;
	/** The one approval card every channel renders (doc/design/channels.md "Approvals"). */
	approvalCard: (request: ApprovalRequest, options: { withButtons: boolean; withSource: boolean }) => ChatCard;
	signatureCard: (request: ApprovalRequest, link: string | null, options: { withSource: boolean }) => ChatCard;
	quotaCard: (title: string, status: QuotaStatus) => ChatCard;
	approvedResult: (by: string) => string;
	rejectedResult: (by: string, reason: string | null) => string;
	expiredResult: string;
	sessionNotYours: string;
	couldNotReadHistory: (problem: string) => string;
	historyUser: string;
	historyAssistant: string;
	fileOffered: (name: string, source: string) => string;
	turnFailed: (problem: string) => string;
	sessionBody: (title: string, text: string) => string;
	statusUntrackedSession: (status: string, title: string) => string;
	working: string;
	thinking: string;
	running: (toolName: string) => string;
	retrying: (attempt: number) => string;
	approveButton: string;
	rejectButton: string;
	draftStarted: (model: string, thinking: string, rulePreset: string) => string;
	modelTitle: (page: number, pages: number) => string;
	modelTitleSingle: string;
	thinkingTitle: (model: string) => string;
	thinkingNone: (model: string) => string;
	thinkingLevel: (level: ThinkingLevel) => string;
	rulesTitle: string;
	extensionsTitle: (page: number, pages: number) => string;
	extensionsTitleSingle: string;
	noExtensions: string;
	modelSet: (model: string) => string;
	thinkingSet: (level: string) => string;
	rulesSet: (rulePreset: string) => string;
	couldNotChange: (problem: string) => string;
	help: string;
	commandMenu: readonly BotCommandMenuEntry[];
}

const en: BotMessages = {
	unsupported: "Only text, files and photos are supported.",
	filesNotSent: "The attached files were not sent.",
	linkHelp:
		"To use ClusterRightHand from this chat, open Settings in the WebUI, create a link code and send /link \\<code> here.",
	noSessions: "You have no sessions yet. Send /new to start one.",
	unknownCommand: (name) =>
		`Unknown command /${escapeMarkdown(name)}. Send /help for the list of commands. To send a message that starts with "/", begin it with another character.`,
	couldNotSaveFile: (problem) => `Could not save the file: ${escapeMarkdown(problem)}`,
	fileTooLarge: (limit) => `The file is larger than your library's limit of ${limit}.`,
	couldNotSendMessage: (problem) => `Could not send the message: ${escapeMarkdown(problem)}`,
	noDefaultModel: "No model is configured; ask an administrator to add one.",
	couldNotStartSession: (problem) => `Could not start a session: ${escapeMarkdown(problem)}`,
	previousArchived: "The previous session is archived.",
	previousUnavailable: "The previous session is no longer available.",
	newSessionStarted: (link) => `Started a new session.${link ? ` ${link}` : ""}`,
	linkMissingCode: "Send /link \\<code> with the code from your settings page.",
	linkInvalidCode: "The link code is invalid, expired or already used.",
	accountNotActive: "That account is not active.",
	linked: "Linked. You can use this chat now. /help lists the commands.",
	alreadyLinked: "This chat is already linked.",
	unlinked: "Unlinked. Send /link \\<code> to link this chat again.",
	newSessionTitle: "New session",
	sessionsTitle: (page, pages) => `Switch this chat to a session (page ${page} of ${pages}):`,
	sessionsTitleSingle: "Switch this chat to a session:",
	previousPage: "‹ Previous",
	nextPage: "Next ›",
	openSession: "Open session",
	choiceHint: (command, page, pages) => {
		if (pages <= 1) return `Send /${command} and a number to choose.`;
		return page < pages
			? `Send /${command} and a number to choose, /${command} page ${page + 1} for the next page.`
			: `Send /${command} and a number to choose, /${command} page ${page - 1} for the previous page.`;
	},
	invalidChoice: (command) => `That is not a choice. Send /${command} for the list.`,
	sessionSwitched: (title) => `Switched to "${escapeMarkdown(title)}".`,
	extensionSet: (name, enabled) => `Extension ${escapeMarkdown(name)} is now ${enabled ? "on" : "off"}.`,
	thinkingHint: "Send /think with a level id, such as /think medium.",
	rulesHint: "Send /rules with a preset id, such as /rules yolo.",
	openSessionLink: (link) => `Open it in the WebUI: ${link}`,
	noRunningSession: "There is no running session in this chat.",
	stopped: "Stopped.",
	couldNotStop: (problem) => `Could not stop: ${escapeMarkdown(problem)}`,
	noSessionInChat: "There is no session in this chat.",
	noSessionYet: "There is no session in this chat yet. Send a message to start one, or /new.",
	quotaAddUsage: "Use /quota add \\<tokens> with a positive whole number of tokens.",
	quotaAdded: (tokens) => `Added ${tokens} tokens to the session's quota.`,
	quotaEnded: "Ended the turn.",
	noQuota: "This session has no token quota.",
	quotaUsedUp: (over, used) =>
		`Used up, over by ${tokenCount(over, "en")} tokens (${tokenCount(used, "en")} used).\n\n/quota add \\<tokens> raises it and continues\n\n/quota stop ends the turn.`,
	quotaRemaining: (used, remaining) => `Used ${tokenCount(used, "en")} · ${tokenCount(remaining, "en")} left.`,
	decideUsage: (name, withReason) => `Use /${name} \\<id>${withReason ? " [reason]" : ""}.`,
	noWaitingApproval: "No waiting approval with that id is yours to decide.",
	approvalNoLongerWaiting: "That approval is no longer waiting, or you may not decide it.",
	card: EN_CARD,
	approvalCard: (request, options) => approvalCardFor(request, options, EN_CARD),
	signatureCard: (request, link, options) => signatureCardFor(request, link, options, EN_CARD),
	quotaCard: (title, status) => quotaCardFor(title, status, EN_CARD),
	approvedResult: (by) => EN_CARD.approvedResult(by),
	rejectedResult: (by, reason) => EN_CARD.rejectedResult(by, reason),
	expiredResult: EN_CARD.expired,
	sessionNotYours: "That session is not yours to attach.",
	couldNotReadHistory: (problem) => `Could not read the session's history: ${escapeMarkdown(problem)}`,
	historyUser: "You",
	historyAssistant: "Assistant",
	fileOffered: (name, source) => `File offered: ${escapeMarkdown(name)}\n\n${source}`,
	turnFailed: (problem) => `The turn failed: ${escapeMarkdown(problem)}`,
	sessionBody: (title, text) => `Session "${escapeMarkdown(title)}":\n\n${text}`,
	statusUntrackedSession: (status, title) => `${status}\n\nThis is the session "${escapeMarkdown(title)}".`,
	working: "Working…",
	thinking: "Thinking…",
	running: (toolName) => `Running ${toolName}…`,
	retrying: (attempt) => `Retrying (attempt ${attempt})…`,
	approveButton: "Approve",
	rejectButton: "Reject",
	draftStarted: (model, thinking, rulePreset) =>
		[
			"New session draft:",
			"",
			`- Model: ${escapeMarkdown(model)}`,
			`- Thinking: ${escapeMarkdown(thinking)}`,
			`- Rules: ${escapeMarkdown(rulePreset)}`,
			"",
			"Change it with /model, /think, /rules or /extensions; send a message to start the session.",
		].join("\n"),
	modelTitle: (page, pages) => `Choose a model (page ${page} of ${pages}):`,
	modelTitleSingle: "Choose a model:",
	thinkingTitle: (model) => `Thinking level for ${escapeMarkdown(model)}:`,
	thinkingNone: (model) => `${escapeMarkdown(model)} has no thinking levels.`,
	thinkingLevel: (level) =>
		({
			off: "Off",
			minimal: "Minimal",
			low: "Low",
			medium: "Medium",
			high: "High",
			xhigh: "Extra high",
			max: "Max",
		})[level],
	rulesTitle: "Rule preset:",
	extensionsTitle: (page, pages) => `Extensions (page ${page} of ${pages}):`,
	extensionsTitleSingle: "Extensions:",
	noExtensions: "No extensions are available to this session.",
	modelSet: (model) => `Model set to ${escapeMarkdown(model)}.`,
	thinkingSet: (level) => `Thinking level set to ${escapeMarkdown(level)}.`,
	rulesSet: (rulePreset) => `Rule preset set to ${escapeMarkdown(rulePreset)}.`,
	couldNotChange: (problem) => `Could not change it: ${escapeMarkdown(problem)}`,
	help: [
		"ClusterRightHand commands:",
		"",
		"- /link \\<code> — link this chat to your account",
		"- /unlink — unlink this chat",
		"- /new — start a new session",
		"- /model \\[n\\] — choose the session's model by number",
		"- /think \\[level\\] — set its thinking level",
		"- /rules \\[preset\\] — set its rule preset",
		"- /extensions \\[n\\] — turn an extension on or off by number",
		"- /sessions \\[n\\] — switch to a session by number",
		"- /stop — stop the running turn",
		"- /quota — show the session's token quota",
		"- /quota add \\<tokens> — raise it and continue",
		"- /quota stop — end the turn waiting for tokens",
		"- /approve \\[id\\] — approve a waiting request (the only one waiting here when the id is left out)",
		"- /reject \\[id\\] \\[reason\\] — reject it (without an id, every word is the reason)",
		"- /help — this list",
	].join("\n"),
	commandMenu: [
		{ command: "link", description: "Link this chat to your account" },
		{ command: "unlink", description: "Unlink this chat" },
		{ command: "new", description: "Start a new session" },
		{ command: "model", description: "Choose the session's model" },
		{ command: "think", description: "Choose the session's thinking level" },
		{ command: "rules", description: "Choose the session's rule preset" },
		{ command: "extensions", description: "Turn extensions on or off" },
		{ command: "sessions", description: "Switch to one of your sessions" },
		{ command: "stop", description: "Stop the running turn" },
		{ command: "quota", description: "Show or change the session's token quota" },
		{ command: "approve", description: "Approve a waiting request" },
		{ command: "reject", description: "Reject a waiting request" },
		{ command: "help", description: "List the commands" },
		{ command: "start", description: "Show the command list" },
	],
};

const zhCN: BotMessages = {
	unsupported: "仅支持文本、文件和图片。",
	filesNotSent: "附件未发送。",
	linkHelp: "要在聊天中使用 ClusterRightHand，请打开 WebUI 的设置，创建关联码，然后在这里发送 /link \\<code>。",
	noSessions: "你还没有会话。发送 /new 开始一个。",
	unknownCommand: (name) =>
		`未知命令 /${escapeMarkdown(name)}。发送 /help 查看命令列表。要发送以“/”开头的消息，请在开头再加一个字符。`,
	couldNotSaveFile: (problem) => `无法保存文件：${escapeMarkdown(problem)}`,
	fileTooLarge: (limit) => `文件超过了你的库的单文件上限（${limit}）。`,
	couldNotSendMessage: (problem) => `无法发送消息：${escapeMarkdown(problem)}`,
	noDefaultModel: "尚未配置模型；请联系管理员添加。",
	couldNotStartSession: (problem) => `无法开始会话：${escapeMarkdown(problem)}`,
	previousArchived: "上一个会话已归档。",
	previousUnavailable: "上一个会话已不可用。",
	newSessionStarted: (link) => `已开始新会话。${link ? `\n${link}` : ""}`,
	linkMissingCode: "请发送 /link \\<code>，其中 code 来自你的设置页面。",
	linkInvalidCode: "关联码无效、已过期或已被使用。",
	accountNotActive: "该账户未启用。",
	linked: "已关联。现在可以使用此聊天了。/help 列出命令。",
	alreadyLinked: "此聊天已关联。",
	unlinked: "已取消关联。发送 /link \\<code> 可重新关联此聊天。",
	newSessionTitle: "新会话",
	sessionsTitle: (page, pages) => `将此聊天切换到某个会话（第 ${page} 页，共 ${pages} 页）：`,
	sessionsTitleSingle: "将此聊天切换到某个会话：",
	previousPage: "‹ 上一页",
	nextPage: "下一页 ›",
	openSession: "打开会话",
	choiceHint: (command, page, pages) => {
		if (pages <= 1) return `发送 /${command} 加序号进行选择。`;
		return page < pages
			? `发送 /${command} 加序号进行选择，发送 /${command} page ${page + 1} 查看下一页。`
			: `发送 /${command} 加序号进行选择，发送 /${command} page ${page - 1} 查看上一页。`;
	},
	invalidChoice: (command) => `这不是有效的选项。发送 /${command} 查看列表。`,
	sessionSwitched: (title) => `已切换到“${escapeMarkdown(title)}”。`,
	extensionSet: (name, enabled) => `扩展 ${escapeMarkdown(name)} 已${enabled ? "开启" : "关闭"}。`,
	thinkingHint: "发送 /think 并附上级别 id，例如 /think medium。",
	rulesHint: "发送 /rules 并附上预设 id，例如 /rules yolo。",
	openSessionLink: (link) => `在 WebUI 中打开：${link}`,
	noRunningSession: "此聊天中没有正在运行的会话。",
	stopped: "已停止。",
	couldNotStop: (problem) => `无法停止：${escapeMarkdown(problem)}`,
	noSessionInChat: "此聊天中没有会话。",
	noSessionYet: "此聊天中还没有会话。发送一条消息即可开始，或发送 /new。",
	quotaAddUsage: "请使用 /quota add \\<tokens>，tokens 为正整数。",
	quotaAdded: (tokens) => `已向该会话的配额增加 ${tokens} 个令牌。`,
	quotaEnded: "已结束本回合。",
	noQuota: "此会话没有令牌配额。",
	quotaUsedUp: (over, used) =>
		`已用完，超出 ${tokenCount(over, "zh-CN")} 个令牌（已用 ${tokenCount(used, "zh-CN")}）。\n\n/quota add \\<tokens> 可提高配额并继续\n\n/quota stop 结束本回合。`,
	quotaRemaining: (used, remaining) => `已用 ${tokenCount(used, "zh-CN")} · 剩余 ${tokenCount(remaining, "zh-CN")}。`,
	decideUsage: (name, withReason) => `请使用 /${name} \\<id>${withReason ? " [原因]" : ""}。`,
	noWaitingApproval: "没有属于你、等待审批且 id 相符的请求。",
	approvalNoLongerWaiting: "该审批已不再等待，或你无权决定。",
	card: ZH_CARD,
	approvalCard: (request, options) => approvalCardFor(request, options, ZH_CARD),
	signatureCard: (request, link, options) => signatureCardFor(request, link, options, ZH_CARD),
	quotaCard: (title, status) => quotaCardFor(title, status, ZH_CARD),
	approvedResult: (by) => ZH_CARD.approvedResult(by),
	rejectedResult: (by, reason) => ZH_CARD.rejectedResult(by, reason),
	expiredResult: ZH_CARD.expired,
	sessionNotYours: "该会话不属于你，无法附加。",
	couldNotReadHistory: (problem) => `无法读取会话历史：${escapeMarkdown(problem)}`,
	historyUser: "你",
	historyAssistant: "助手",
	fileOffered: (name, source) => `文件已提供：${escapeMarkdown(name)}\n\n${source}`,
	turnFailed: (problem) => `本回合失败：${escapeMarkdown(problem)}`,
	sessionBody: (title, text) => `会话“${escapeMarkdown(title)}”：\n\n${text}`,
	statusUntrackedSession: (status, title) => `${status}\n\n这是会话“${escapeMarkdown(title)}”。`,
	working: "处理中…",
	thinking: "思考中…",
	running: (toolName) => `正在运行 ${toolName}…`,
	retrying: (attempt) => `正在重试（第 ${attempt} 次）…`,
	approveButton: "批准",
	rejectButton: "拒绝",
	draftStarted: (model, thinking, rulePreset) =>
		[
			"新会话草稿：",
			"",
			`- 模型：${escapeMarkdown(model)}`,
			`- 思考级别：${escapeMarkdown(thinking)}`,
			`- 规则预设：${escapeMarkdown(rulePreset)}`,
			"",
			"用 /model、/think、/rules 或 /extensions 修改；发送消息即可开始会话。",
		].join("\n"),
	modelTitle: (page, pages) => `选择模型（第 ${page} 页，共 ${pages} 页）：`,
	modelTitleSingle: "选择模型：",
	thinkingTitle: (model) => `${escapeMarkdown(model)} 的思考级别：`,
	thinkingNone: (model) => `${escapeMarkdown(model)} 没有可选的思考级别。`,
	thinkingLevel: (level) =>
		({
			off: "关闭",
			minimal: "最低",
			low: "低",
			medium: "中",
			high: "高",
			xhigh: "很高",
			max: "最高",
		})[level],
	rulesTitle: "规则预设：",
	extensionsTitle: (page, pages) => `扩展（第 ${page} 页，共 ${pages} 页）：`,
	extensionsTitleSingle: "扩展：",
	noExtensions: "此会话没有可用的扩展。",
	modelSet: (model) => `模型已设为 ${escapeMarkdown(model)}。`,
	thinkingSet: (level) => `思考级别已设为 ${escapeMarkdown(level)}。`,
	rulesSet: (rulePreset) => `规则预设已设为 ${escapeMarkdown(rulePreset)}。`,
	couldNotChange: (problem) => `无法更改：${escapeMarkdown(problem)}`,
	help: [
		"ClusterRightHand 命令：",
		"",
		"- /link \\<code> — 将此聊天与你的账户关联",
		"- /unlink — 取消关联此聊天",
		"- /new — 开始新会话",
		"- /model \\[n\\] — 按序号选择会话的模型",
		"- /think \\[level\\] — 设置会话的思考级别",
		"- /rules \\[preset\\] — 设置会话的规则预设",
		"- /extensions \\[n\\] — 按序号开启或关闭扩展",
		"- /sessions \\[n\\] — 按序号切换到某个会话",
		"- /stop — 停止正在运行的回合",
		"- /quota — 查看会话的令牌配额",
		"- /quota add \\<tokens> — 提高配额并继续",
		"- /quota stop — 结束等待令牌的回合",
		"- /approve \\[id\\] — 批准等待中的请求（省略 id 时，批准此聊天中唯一等待的请求）",
		"- /reject \\[id\\] \\[原因\\] — 拒绝该请求（省略 id 时，后面的文字都作为原因）",
		"- /help — 本列表",
	].join("\n"),
	commandMenu: [
		{ command: "link", description: "将此聊天与你的账户关联" },
		{ command: "unlink", description: "取消关联此聊天" },
		{ command: "new", description: "开始新会话" },
		{ command: "model", description: "选择会话的模型" },
		{ command: "think", description: "选择会话的思考级别" },
		{ command: "rules", description: "选择会话的规则预设" },
		{ command: "extensions", description: "开启或关闭扩展" },
		{ command: "sessions", description: "切换到你的某个会话" },
		{ command: "stop", description: "停止正在运行的回合" },
		{ command: "quota", description: "查看或调整会话的令牌配额" },
		{ command: "approve", description: "批准等待中的请求" },
		{ command: "reject", description: "拒绝等待中的请求" },
		{ command: "help", description: "列出所有命令" },
		{ command: "start", description: "显示命令列表" },
	],
};

/**
 * One platform `language_code` through the shared registry (packages/api/src/locales.ts); an unknown tag
 * falls through to English, and `zh-Hant`/`zh-TW` resolve to zh-CN until a Traditional catalogue exists.
 */
export function localeFromLanguageCode(languageCode: string | null | undefined): BotLocale {
	return matchLocale(languageCode ? [languageCode] : []) ?? "en";
}

/**
 * The saved user locale wins; otherwise the reported platform language decides and finally English
 * (doc/design/channels.md "Messages" and "Notifications").
 */
export function botLocale(locale: UserSettingsLocale | null | undefined, languageCode?: string | null): BotLocale {
	return locale ?? localeFromLanguageCode(languageCode);
}

export function messagesFor(locale: BotLocale | null | undefined): BotMessages {
	return locale === "zh-CN" ? zhCN : en;
}
