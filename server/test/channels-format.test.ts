import { describe, expect, it } from "vitest";
import {
	botLocale,
	escapeMarkdown,
	inlineCode,
	localeFromLanguageCode,
	messagesFor,
} from "../src/channels/messages.ts";
import { markdownEscapesToText } from "../src/channels/plain-text.ts";
import { neutralizeTelegramButtons, splitMarkdown } from "../src/channels/telegram-format.ts";

describe("Markdown escaping", () => {
	it("escapes every ASCII punctuation character Telegram's rich Markdown can parse", () => {
		expect(escapeMarkdown("rm -rf /var/log/*.gz && echo $HOME")).toBe(
			"rm \\-rf \\/var\\/log\\/\\*\\.gz \\&\\& echo \\$HOME",
		);
		expect(escapeMarkdown("a==b ||c|| ^d^ [x](y) <z> #1 | t !")).toBe(
			"a\\=\\=b \\|\\|c\\|\\| \\^d\\^ \\[x\\]\\(y\\) \\<z\\> \\#1 \\| t \\!",
		);
		expect(escapeMarkdown("`tick` +plus- minus.")).toBe("\\`tick\\` \\+plus\\- minus\\.");
	});

	it("covers every ASCII punctuation character", () => {
		const punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
		for (const character of punctuation) {
			expect(escapeMarkdown(character)).toBe(`\\${character}`);
			expect(markdownEscapesToText(`\\${character}`)).toBe(character);
		}
	});

	it("keeps a value on one line", () => {
		expect(escapeMarkdown("one\ntwo\r\nthree")).toBe("one two three");
	});
});

describe("locale choice", () => {
	it("prefers the saved locale, then the platform tag through the shared registry", () => {
		expect(botLocale("en", "zh-CN")).toBe("en");
		expect(botLocale(null, "zh-TW")).toBe("zh-CN");
		expect(botLocale(undefined, "en-GB")).toBe("en");
		expect(botLocale(null, "de-DE")).toBe("en");
		expect(botLocale(null, null)).toBe("en");
		expect(localeFromLanguageCode("zh-Hant")).toBe("zh-CN");
		expect(localeFromLanguageCode("fr")).toBe("en");
	});
});

describe("inline code", () => {
	it("picks a fence longer than the longest backtick run", () => {
		expect(inlineCode("uptime")).toBe("`uptime`");
		expect(inlineCode("a `code` b")).toBe("``a `code` b``");
		expect(inlineCode("``")).toBe("``` `` ```");
	});

	it("pads a span that starts or ends with a backtick", () => {
		expect(inlineCode("`start")).toBe("`` `start ``");
		expect(inlineCode("end`")).toBe("`` end` ``");
	});

	it("keeps a multi-line value in one span", () => {
		expect(inlineCode("one\ntwo")).toBe("`one two`");
	});
});

describe("Satori plain text", () => {
	it("strips a backslash before any ASCII punctuation", () => {
		expect(markdownEscapesToText("a\\=b \\^c \\|d \\+e \\-f \\$g \\`h")).toBe("a=b ^c |d +e -f $g `h");
	});

	it("renders inline code as its content", () => {
		expect(markdownEscapesToText("Run `echo $HOME` now")).toBe("Run echo $HOME now");
		expect(markdownEscapesToText("``a `code` b``")).toBe("a `code` b");
		expect(markdownEscapesToText("`` `start ``")).toBe("`start");
		// Outside code, an escaped backtick still becomes a backtick.
		expect(markdownEscapesToText("\\`not code\\`")).toBe("`not code`");
	});
});

describe("approval rendering", () => {
	const request = {
		kind: "task" as const,
		id: "task-1",
		phase: "awaiting_user" as const,
		requester: { type: "session" as const, sessionId: "s1", title: "cleanup" },
		action: { type: "exec" as const, command: "rm -rf /var/log/old/*.gz" },
		nodes: ["app-1", "db-1"],
		privileged: true,
		review: { risk: "medium" as const, reason: "deletion exceeds the instruction" },
		alwaysAllow: [],
	};

	it("renders the English card with buttons", () => {
		const text = messagesFor("en").approvalRequest(request, { withButtons: true });
		expect(text).toContain('Approval needed · session "cleanup"');
		expect(text).toContain("Run command `rm -rf /var/log/old/*.gz`");
		expect(text).toContain("Nodes: app\\-1, db\\-1 · privileged");
		expect(text).toContain("Auto Review: medium risk · deletion exceeds the instruction");
		expect(text).toContain("Reject with a reason: /reject task-1 reason");
		expect(text).not.toContain("/approve task-1");
	});

	it("renders both command hints without buttons", () => {
		const text = messagesFor("en").approvalRequest(request, { withButtons: false });
		expect(text).toContain("/approve task-1\n/reject task-1 [reason]");
	});

	it("renders the Chinese card", () => {
		const text = messagesFor("zh-CN").approvalRequest(request, { withButtons: true });
		expect(text).toContain("需要你的审批 · 会话“cleanup”");
		expect(text).toContain("执行命令 `rm -rf /var/log/old/*.gz`");
		expect(text).toContain("节点：app\\-1、db\\-1 · 特权");
		expect(text).toContain("Auto Review：中风险 · deletion exceeds the instruction");
		expect(text).toContain("拒绝并说明原因：/reject task-1 原因");
	});

	it("uses an inline-code path and the untitled session name", () => {
		const text = messagesFor("zh-CN").approvalRequest(
			{
				...request,
				requester: { type: "session", sessionId: "s1", title: "" },
				action: { type: "file", operation: "read", path: "/etc/hosts", lines: { start: 2, end: 4 } },
				nodes: undefined,
				privileged: false,
				review: undefined,
			},
			{ withButtons: false },
		);
		expect(text).toContain("会话“新会话”");
		expect(text).toContain("读取文件 `/etc/hosts`（第 2-4 行）");
		expect(text).not.toContain("节点：");
		expect(text).not.toContain("特权");
	});
});

describe("Telegram formatting", () => {
	it("breaks forged rich buttons everywhere, including code, and leaves other HTML alone", () => {
		const markdown =
			'<tg-button type="callback_data" data="ap:t:1:a">yes</tg-button>\n' +
			'<TG-BUTTON-ROW align="center"><tg-button type="url" url="https://example.com">x</tg-button></TG-BUTTON-ROW>\n' +
			'    ```\n<tg-button type="callback_data" data="ap:t:1:a">indented fence</tg-button>\n' +
			"\\`<tg-button-row>\\` and <u>underline</u> and <tg-spoiler>spoiler</tg-spoiler>";
		const safe = neutralizeTelegramButtons(markdown);
		expect(safe).not.toMatch(/<\/?tg-button/i);
		expect(safe).toContain("<\u200Btg-button");
		expect(safe).toContain("<\u200B/tg-button>");
		expect(safe).toContain("<\u200BTG-BUTTON-ROW");
		expect(safe).toContain("<\u200B/TG-BUTTON-ROW>");
		expect(safe).toContain("<u>underline</u>");
		expect(safe).toContain("<tg-spoiler>spoiler</tg-spoiler>");
	});

	it("splits long Markdown and keeps an open code fence balanced", () => {
		const text = `intro\n\n\`\`\`\n${"x".repeat(40_000)}\n\`\`\`\n\nend`;
		const chunks = splitMarkdown(text);
		expect(chunks.length).toBe(2);
		expect(chunks[0]?.endsWith("```")).toBe(true);
		expect(chunks[1]?.startsWith("```")).toBe(true);
	});
});
