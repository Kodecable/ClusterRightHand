import { describe, expect, it } from "vitest";
import { neutralizeTelegramButtons, splitMarkdown } from "../src/channels/telegram-format.ts";

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
