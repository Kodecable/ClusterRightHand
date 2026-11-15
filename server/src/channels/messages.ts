import type { ThinkingLevel, UserSettingsLocale } from "@crh/api";

/**
 * The chat bot's fixed texts (doc/design/channels.md "Messages"), in English and Chinese. Both catalogues
 * are typed with the same interface, so a missing or extra key is a type error. Messages with values are
 * functions; model output is never translated.
 *
 * The Telegram adapter sends these as rich Markdown, where a single newline is a soft break: multi-line
 * texts use blank lines between paragraphs and Markdown lists for commands, and values that come from a
 * user or a model are escaped so they show literally. A `draft` status is plain text and not escaped.
 */

export type BotLocale = UserSettingsLocale;

/** Escapes the Markdown characters of a value interpolated into a framework text. */
export function escapeMarkdown(text: string): string {
	return text.replace(/\r?\n/g, " ").replace(/([\\`*_[\]()~<>#|!])/g, "\\$1");
}

export interface BotCommandMenuEntry {
	command: string;
	description: string;
}

/** The `/help` list and the Telegram command menu share these commands. */
export interface BotMessages {
	unsupported: string;
	filesNotSent: string;
	linkHelp: string;
	noSessions: string;
	unknownCommand: (name: string) => string;
	couldNotSaveFile: (problem: string) => string;
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
	noRunningSession: string;
	stopped: string;
	couldNotStop: (problem: string) => string;
	noSessionInChat: string;
	noSessionYet: string;
	quotaAddUsage: string;
	quotaAdded: (tokens: number) => string;
	quotaEnded: string;
	noQuota: string;
	quotaUsedUp: (remaining: number, used: number) => string;
	quotaRemaining: (remaining: number, used: number) => string;
	decideUsage: (name: string, withReason: boolean) => string;
	noWaitingApproval: string;
	approved: string;
	rejected: string;
	approvalNoLongerWaiting: string;
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
	waitingApproval: string;
	waitingSignature: string;
	taskSignatureWait: (id: string, link: string | null) => string;
	taskGroupSignatureWait: (id: string, link: string | null) => string;
	taskApproval: (summary: string, id: string) => string;
	taskGroupApproval: (summary: string, id: string) => string;
	callApproval: (what: string, id: string) => string;
	quotaWait: (title: string, remaining: number, used: number) => string;
	approveButton: string;
	rejectButton: string;
	sessionGone: string;
	quotaWaitEnded: string;
	waitEnded: string;
	taskGone: string;
	taskGroupGone: string;
	callGone: string;
	approvedEnding: string;
	rejectedEnding: (reason: string | null) => string;
	approvedBy: (by: string) => string;
	rejectedBy: (by: string, reason: string | null) => string;
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
	couldNotSendMessage: (problem) => `Could not send the message: ${escapeMarkdown(problem)}`,
	noDefaultModel: "No model is configured; ask an administrator to add one.",
	couldNotStartSession: (problem) => `Could not start a session: ${escapeMarkdown(problem)}`,
	previousArchived: "The previous session is archived. ",
	previousUnavailable: "The previous session is no longer available. ",
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
	noRunningSession: "There is no running session in this chat.",
	stopped: "Stopped.",
	couldNotStop: (problem) => `Could not stop: ${escapeMarkdown(problem)}`,
	noSessionInChat: "There is no session in this chat.",
	noSessionYet: "There is no session in this chat yet. Send a message to start one, or /new.",
	quotaAddUsage: "Use /quota add \\<tokens> with a positive whole number of tokens.",
	quotaAdded: (tokens) => `Added ${tokens} tokens to the session's quota.`,
	quotaEnded: "Ended the turn.",
	noQuota: "This session has no token quota.",
	quotaUsedUp: (remaining, used) =>
		`This session's token quota is used up (${remaining} remaining, ${used} used).\n\n/quota add \\<tokens> raises it and continues\n\n/quota stop ends the turn.`,
	quotaRemaining: (remaining, used) => `This session has ${remaining} tokens left (${used} used).`,
	decideUsage: (name, withReason) => `Use /${name} \\<id>${withReason ? " [reason]" : ""}.`,
	noWaitingApproval: "No waiting approval with that id is yours to decide.",
	approved: "Approved.",
	rejected: "Rejected.",
	approvalNoLongerWaiting: "That approval is no longer waiting, or you may not decide it.",
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
	waitingApproval: "Waiting for approval…",
	waitingSignature: "Waiting for a signature…",
	taskSignatureWait: (id, link) => `Task ${id} waits for your signature.${link ? `\n\n${link}` : ""}`,
	taskGroupSignatureWait: (id, link) => `Task group ${id} waits for your signature.${link ? `\n\n${link}` : ""}`,
	taskApproval: (summary, id) =>
		`Approval needed for a task:\n\n${escapeMarkdown(summary)}\n\n/approve ${id}\n\n/reject ${id} [reason]`,
	taskGroupApproval: (summary, id) =>
		`Approval needed for a task group:\n\n${escapeMarkdown(summary)}\n\n/approve ${id}\n\n/reject ${id} [reason]`,
	callApproval: (what, id) =>
		`Approval needed for an extension call:\n\n${escapeMarkdown(what)}\n\n/approve ${id}\n\n/reject ${id} [reason]`,
	quotaWait: (title, remaining, used) =>
		`The token quota of "${escapeMarkdown(title)}" is used up (${remaining} remaining, ${used} used).\n\n/quota add \\<tokens> continues\n\n/quota stop ends the turn`,
	approveButton: "Approve",
	rejectButton: "Reject",
	sessionGone: "The session is gone.",
	quotaWaitEnded: "The quota wait ended.",
	waitEnded: "The wait ended.",
	taskGone: "The task is gone.",
	taskGroupGone: "The task group is gone.",
	callGone: "The call is gone.",
	approvedEnding: "Approved.",
	rejectedEnding: (reason) => (reason ? `Rejected: ${escapeMarkdown(reason)}` : "Rejected."),
	approvedBy: (by) => `Approved by ${escapeMarkdown(by)}.`,
	rejectedBy: (by, reason) => `Rejected by ${escapeMarkdown(by)}${reason ? `: ${escapeMarkdown(reason)}` : ""}.`,
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
		"- /model — choose the session's model",
		"- /think — choose its thinking level",
		"- /rules — choose its rule preset",
		"- /extensions — turn extensions on or off",
		"- /sessions — switch to one of your sessions",
		"- /stop — stop the running turn",
		"- /quota — show the session's token quota",
		"- /quota add \\<tokens> — raise it and continue",
		"- /quota stop — end the turn waiting for tokens",
		"- /approve \\<id> — approve a waiting request",
		"- /reject \\<id> [reason] — reject it",
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
	couldNotSendMessage: (problem) => `无法发送消息：${escapeMarkdown(problem)}`,
	noDefaultModel: "尚未配置模型；请联系管理员添加。",
	couldNotStartSession: (problem) => `无法开始会话：${escapeMarkdown(problem)}`,
	previousArchived: "上一个会话已归档。",
	previousUnavailable: "上一个会话已不可用。",
	newSessionStarted: (link) => `已开始新会话。${link ? ` ${link}` : ""}`,
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
	noRunningSession: "此聊天中没有正在运行的会话。",
	stopped: "已停止。",
	couldNotStop: (problem) => `无法停止：${escapeMarkdown(problem)}`,
	noSessionInChat: "此聊天中没有会话。",
	noSessionYet: "此聊天中还没有会话。发送一条消息即可开始，或发送 /new。",
	quotaAddUsage: "请使用 /quota add \\<tokens>，tokens 为正整数。",
	quotaAdded: (tokens) => `已向该会话的配额增加 ${tokens} 个令牌。`,
	quotaEnded: "已结束本回合。",
	noQuota: "此会话没有令牌配额。",
	quotaUsedUp: (remaining, used) =>
		`此会话的令牌配额已用完（剩余 ${remaining}，已用 ${used}）。\n\n/quota add \\<tokens> 可提高配额并继续\n\n/quota stop 结束本回合。`,
	quotaRemaining: (remaining, used) => `此会话还剩 ${remaining} 个令牌（已用 ${used}）。`,
	decideUsage: (name, withReason) => `请使用 /${name} \\<id>${withReason ? " [原因]" : ""}。`,
	noWaitingApproval: "没有属于你、等待审批且 id 相符的请求。",
	approved: "已批准。",
	rejected: "已拒绝。",
	approvalNoLongerWaiting: "该审批已不再等待，或你无权决定。",
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
	waitingApproval: "等待审批…",
	waitingSignature: "等待签名…",
	taskSignatureWait: (id, link) => `任务 ${id} 等待你的签名。${link ? `\n\n${link}` : ""}`,
	taskGroupSignatureWait: (id, link) => `任务组 ${id} 等待你的签名。${link ? `\n\n${link}` : ""}`,
	taskApproval: (summary, id) =>
		`任务需要审批：\n\n${escapeMarkdown(summary)}\n\n/approve ${id}\n\n/reject ${id} [原因]`,
	taskGroupApproval: (summary, id) =>
		`任务组需要审批：\n\n${escapeMarkdown(summary)}\n\n/approve ${id}\n\n/reject ${id} [原因]`,
	callApproval: (what, id) => `扩展调用需要审批：\n\n${escapeMarkdown(what)}\n\n/approve ${id}\n\n/reject ${id} [原因]`,
	quotaWait: (title, remaining, used) =>
		`会话“${escapeMarkdown(title)}”的令牌配额已用完（剩余 ${remaining}，已用 ${used}）。\n\n/quota add \\<tokens> 继续\n\n/quota stop 结束本回合`,
	approveButton: "批准",
	rejectButton: "拒绝",
	sessionGone: "会话已不存在。",
	quotaWaitEnded: "配额等待已结束。",
	waitEnded: "等待已结束。",
	taskGone: "任务已不存在。",
	taskGroupGone: "任务组已不存在。",
	callGone: "调用已不存在。",
	approvedEnding: "已批准。",
	rejectedEnding: (reason) => (reason ? `已拒绝：${escapeMarkdown(reason)}` : "已拒绝。"),
	approvedBy: (by) => `已由 ${escapeMarkdown(by)} 批准。`,
	rejectedBy: (by, reason) => `已由 ${escapeMarkdown(by)} 拒绝${reason ? `：${escapeMarkdown(reason)}` : ""}。`,
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
		"- /model — 选择会话的模型",
		"- /think — 选择会话的思考级别",
		"- /rules — 选择会话的规则预设",
		"- /extensions — 开启或关闭扩展",
		"- /sessions — 切换到你的某个会话",
		"- /stop — 停止正在运行的回合",
		"- /quota — 查看会话的令牌配额",
		"- /quota add \\<tokens> — 提高配额并继续",
		"- /quota stop — 结束等待令牌的回合",
		"- /approve \\<id> — 批准等待中的请求",
		"- /reject \\<id> [原因] — 拒绝该请求",
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

/** The platform language a message carries: `zh*` is Chinese, everything else English. */
export function localeFromLanguageCode(languageCode: string | null | undefined): BotLocale {
	return languageCode?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** A linked user's locale wins; without one (or with a null locale) the platform language decides. */
export function botLocale(locale: UserSettingsLocale | null | undefined, languageCode?: string | null): BotLocale {
	return locale ?? localeFromLanguageCode(languageCode);
}

export function messagesFor(locale: BotLocale | null | undefined): BotMessages {
	return locale === "zh-CN" ? zhCN : en;
}
