import { describe, expect, it } from "vitest";
import {
	botLocale,
	codeBlock,
	escapeMarkdown,
	inlineCode,
	localeFromLanguageCode,
	messagesFor,
} from "../src/channels/messages.ts";
import { markdownEscapesToText } from "../src/channels/plain-text.ts";
import { neutralizeTelegramButtons, splitMarkdown } from "../src/channels/telegram-format.ts";

/** The characters Telegram's rich Markdown consumes a backslash before, measured against the API. */
const CONSUMED = "!#$()*+-.=>[]\\_`{|}~";
/** The characters that stay as written, with a literal backslash shown in front when one is written. */
const PLAIN = "\"%',/:;?@^";

describe("Markdown escaping", () => {
	it("escapes exactly what Telegram's rich Markdown consumes a backslash before", () => {
		expect(escapeMarkdown("rm -rf /var/log/*.gz && echo $HOME")).toBe(
			"rm \\-rf /var/log/\\*\\.gz &amp;&amp; echo \\$HOME",
		);
		expect(escapeMarkdown("a==b ||c|| ^d^ [x](y) <z> #1 | t !")).toBe(
			"a\\=\\=b \\|\\|c\\|\\| ^d^ \\[x\\]\\(y\\) &lt;z\\> \\#1 \\| t \\!",
		);
		expect(escapeMarkdown("`tick` +plus- minus.")).toBe("\\`tick\\` \\+plus\\- minus\\.");
		expect(escapeMarkdown("AT&T <b> \"quoted\" 100% /help 'x'")).toBe("AT&amp;T &lt;b\\> \"quoted\" 100% /help 'x'");
	});

	it("covers every ASCII punctuation character with the measured rule", () => {
		const punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
		for (const character of punctuation) {
			if (character === "&") {
				expect(escapeMarkdown(character)).toBe("&amp;");
			} else if (character === "<") {
				expect(escapeMarkdown(character)).toBe("&lt;");
			} else if (CONSUMED.includes(character)) {
				expect(escapeMarkdown(character)).toBe(`\\${character}`);
			} else {
				expect(PLAIN).toContain(character);
				expect(escapeMarkdown(character)).toBe(character);
			}
			expect(markdownEscapesToText(escapeMarkdown(character))).toBe(character);
		}
	});

	it("round-trips every ASCII punctuation character and a literal entity to plain text", () => {
		const original = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ &lt;";
		expect(markdownEscapesToText(escapeMarkdown(original))).toBe(original);
		expect(markdownEscapesToText(escapeMarkdown(`${original}\nnext`))).toBe(`${original} next`);
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

	it("leaves < and & literal inside a code span", () => {
		expect(inlineCode("a < b & c")).toBe("`a < b & c`");
	});
});

describe("code blocks", () => {
	it("fences a raw error language-lessly, longer than any backtick run inside it", () => {
		expect(codeBlock("400: bad request")).toBe("```\n400: bad request\n```");
		expect(codeBlock("a ` b")).toBe("```\na ` b\n```");
		expect(codeBlock("a ``` b")).toBe("````\na ``` b\n````");
		expect(codeBlock("line one\nline two")).toBe("```\nline one\nline two\n```");
	});

	it("becomes plain text without fence markers, so a run failure reads cleanly", () => {
		const text = `The run failed:\n${codeBlock('400: {"param":"","error":"bad"}')}`;
		expect(markdownEscapesToText(text)).toContain("400:");
		expect(markdownEscapesToText(text)).not.toContain("`");
	});
});

describe("Satori plain text", () => {
	it("removes a backslash only where Telegram's rich Markdown consumes one", () => {
		expect(markdownEscapesToText("a\\=b \\|d \\+e \\-f \\$g \\`h \\[i\\] \\_j \\{k\\} \\~l")).toBe(
			"a=b |d +e -f $g `h [i] _j {k} ~l",
		);
		expect(markdownEscapesToText('\\^c \\%d \\&e \\/f \\:g \\;h \\<i \\?j \\@k \\"l')).toBe(
			'\\^c \\%d \\&e \\/f \\:g \\;h \\<i \\?j \\@k \\"l',
		);
	});

	it("decodes the two entities escaping writes and leaves other entities", () => {
		expect(markdownEscapesToText("a &lt;b&gt; c &amp; d")).toBe("a <b&gt; c & d");
		expect(markdownEscapesToText("&copy; &amp;lt; &#58;")).toBe("&copy; &lt; &#58;");
	});

	it("keeps a hard line break as a line break, without its backslash", () => {
		expect(markdownEscapesToText("one\\\ntwo")).toBe("one\ntwo");
	});

	it("renders inline code as its content", () => {
		expect(markdownEscapesToText("Run `echo $HOME` now")).toBe("Run echo $HOME now");
		expect(markdownEscapesToText("``a `code` b``")).toBe("a `code` b");
		expect(markdownEscapesToText("`` `start ``")).toBe("`start");
		// Outside code, an escaped backtick still becomes a backtick.
		expect(markdownEscapesToText("\\`not code\\`")).toBe("`not code`");
	});

	it("leaves entities and backslashes inside a code span alone", () => {
		expect(markdownEscapesToText("`a &lt; b \\* c`")).toBe("a &lt; b \\* c");
	});
});

describe("failure messages", () => {
	it("puts a run's error in its own code block under the WebUI's wording", () => {
		const en = messagesFor("en");
		const zh = messagesFor("zh-CN");
		expect(en.runFailed('400: {"param":""}')).toBe('The run failed:\n```\n400: {"param":""}\n```');
		expect(zh.runFailed("boom")).toBe("运行失败：\n```\nboom\n```");
		expect(en.runFailed("a ``` fence")).toContain("````\na ``` fence\n````");
		expect(markdownEscapesToText(en.runFailed("bad `fence`"))).not.toContain("\\");
	});

	it("uses the same code-block form for the other messages that embed a raw problem", () => {
		const en = messagesFor("en");
		for (const message of [
			en.couldNotSaveFile("disk full"),
			en.couldNotSendMessage("network down"),
			en.couldNotStartSession("no model"),
			en.couldNotStop("not running"),
			en.couldNotReadHistory("disk on fire"),
			en.couldNotChange("conflict"),
			en.reportError("exit 1"),
		]) {
			expect(message).toContain(":\n```\n");
			expect(message.endsWith("\n```")).toBe(true);
		}
	});
});

describe("history labels", () => {
	it("uses one bold label line for both roles and both catalogues", () => {
		const en = messagesFor("en");
		const zh = messagesFor("zh-CN");
		expect(en.historyUser("one\ntwo")).toBe("**You**\n\none\n\ntwo");
		expect(en.historyAssistant("# Answer")).toBe("**Assistant**\n\n# Answer");
		expect(zh.historyUser("a*b & <c>")).toBe("**你**\n\na\\*b &amp; &lt;c\\>");
		expect(zh.historyAssistant("好")).toBe("**助手**\n\n好");
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
