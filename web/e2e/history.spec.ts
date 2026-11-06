import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { fauxAssistantMessage, fauxText } from "../../server/test/e2e/harness.ts";
import { expect, test } from "./fixtures.ts";

test.use({ withAgent: true });

const MESSAGES = 55;

/** Pages through `GET /sessions/:id/entries` and returns how many entries exist. */
async function entryCount(crhs: InProcessCrhs, sessionId: string): Promise<number> {
	let total = 0;
	let cursor: string | null = null;
	for (let page = 0; page < 20; page++) {
		const query: string = cursor === null ? "?limit=200" : `?before=${encodeURIComponent(cursor)}&limit=200`;
		const res = await crhs.api(`/api/sessions/${sessionId}/entries${query}`);
		if (res.status !== 200) throw new Error(`entries: ${res.status} ${JSON.stringify(res.json)}`);
		total += (res.json.entries as unknown[]).length;
		cursor = res.json.historyCursor as string | null;
		if (cursor === null) return total;
	}
	throw new Error("entries did not end");
}

test("a session with more than 100 entries loads older history at the top without duplicates", async ({
	adminPage: page,
	crhs,
}) => {
	const model = { provider: crhs.faux.provider.id, modelId: crhs.faux.getModel().id };
	crhs.faux.setResponses(
		Array.from({ length: MESSAGES }, (_, index) => fauxAssistantMessage([fauxText(`answer ${index + 1}`)])),
	);
	const created = await crhs.api("/api/sessions", { body: { title: "Long history", model, rulePreset: "yolo" } });
	expect(created.status).toBe(201);
	const sessionId = created.json.session.id as string;

	for (let index = 1; index <= MESSAGES; index++) {
		const posted = await crhs.api(`/api/sessions/${sessionId}/messages`, {
			body: { text: `message ${index}`, requestId: `r-${index}` },
		});
		if (posted.status !== 202) throw new Error(`message ${index}: ${posted.status} ${JSON.stringify(posted.json)}`);
	}
	// Every queued input is answered before the session settles; the entries prove it.
	await expect
		.poll(() => entryCount(crhs, sessionId), { timeout: 120_000, intervals: [200, 500, 1_000] })
		.toBeGreaterThan(100);
	expect(await entryCount(crhs, sessionId)).toBe(MESSAGES * 2);

	await page.goto(`/sessions/${sessionId}`);
	const scroller = page.getByTestId("transcript-scroller");
	await expect(scroller).toHaveAttribute("data-loaded-count", "100", { timeout: 20_000 });
	const firstId = await scroller.getAttribute("data-first-id");
	await expect(scroller).toContainText("answer 55");

	/** A real upward gesture stops bottom-following; a programmatic scroll would be overridden. */
	const scrollUpToTop = async () => {
		await scroller.hover();
		for (let attempt = 0; attempt < 80; attempt++) {
			const top = await scroller.evaluate((element) => element.scrollTop);
			if (top < 1) return;
			await page.mouse.wheel(0, -Math.max(600, top));
			await page.waitForTimeout(40);
		}
	};

	// Reaching the top asks for the older page; the oldest entry exists only there.
	const request = page.waitForRequest((candidate) => candidate.url().includes(`/sessions/${sessionId}/entries?`));
	await scrollUpToTop();
	await request;
	await expect(scroller).toHaveAttribute("data-loaded-count", String(MESSAGES * 2), { timeout: 20_000 });
	await expect(scroller).not.toHaveAttribute("data-first-id", firstId ?? "");

	// No duplicate rows: every loaded entry renders once (110 entries are two per message).
	const loaded = await scroller.getAttribute("data-loaded-count");
	expect(loaded).toBe(String(MESSAGES * 2));
	await scrollUpToTop();
	await expect(scroller).toContainText("message 1", { timeout: 20_000 });
	const duplicateCount = await page.evaluate(() => {
		const ids = [...document.querySelectorAll<HTMLElement>('[data-testid="message"][data-message-id]')].map(
			(row) => row.dataset.messageId as string,
		);
		return ids.length - new Set(ids).size;
	});
	expect(duplicateCount).toBe(0);

	// Nothing older is left; reaching the top again loads no page and adds no row.
	await scrollUpToTop();
	await page.waitForTimeout(500);
	await expect(scroller).toHaveAttribute("data-loaded-count", String(MESSAGES * 2));
});
