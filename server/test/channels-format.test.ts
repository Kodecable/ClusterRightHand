import { describe, expect, it } from "vitest";
import { botLocale, escapeMarkdown, inlineCode, localeFromLanguageCode } from "../src/channels/messages.ts";
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
