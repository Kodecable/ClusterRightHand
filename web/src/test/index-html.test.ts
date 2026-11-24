import { describe, expect, it } from "vitest";
import html from "../../index.html?raw";

describe("index.html", () => {
	it("tells search engines not to index or follow the console", () => {
		expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex, nofollow"\s*\/?>/);
	});
});
