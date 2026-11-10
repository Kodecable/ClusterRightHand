import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	assistantEntry,
	makeTranscript,
	mockApi,
	openSession,
	sessionListItem,
	sessionView,
	snapshotEvent,
	userEntry,
} from "../helpers";

/**
 * The performance runs of doc/design/webui.md "Performance targets", measured against the
 * mocked API (50 ms per response) on Chromium. Each metric is the median of
 * three runs, at 1× and 4× CPU throttling (CDP `Emulation.setCPUThrottlingRate`).
 * The numbers are written to `perf/results.json` and `perf/RESULTS.md`.
 *
 * The pages are opened with `loggedIn: true`, skipping the login form, so the
 * measured "first render" is the section's own first paint and not a login.
 */

test.describe.configure({ mode: "serial" });

/** `PERF_RUNS` / `PERF_STREAM_SCALE` shrink a run for a quick smoke test; the real run uses 3 and 1. */
const RUNS = Math.max(1, Number(process.env.PERF_RUNS ?? "3"));
const STREAM_SCALE = Math.max(0.01, Number(process.env.PERF_STREAM_SCALE ?? "1"));

type Cdp = Awaited<ReturnType<BrowserContext["newCDPSession"]>>;
type Metrics = { name: string; value: number }[];

interface Entry {
	throttle: number;
	reps: number[];
	notes?: string;
}
const results: Record<string, Entry> = {};

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
		: (sorted[middle] as number);
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] as number;
}

function record(key: string, throttle: number, reps: number[], notes?: string): void {
	results[`${key}@${throttle}`] = { throttle, reps, ...(notes === undefined ? {} : { notes }) };
	console.log(
		`${key} @${throttle}x: ${reps.map((value) => round(value)).join(", ")} (median ${round(median(reps))})` +
			(notes === undefined ? "" : ` — ${notes}`),
	);
}

async function throttledPage(
	browser: Browser,
	rate: number,
): Promise<{ page: Page; cdp: Cdp; close: () => Promise<void> }> {
	const context = await browser.newContext({ baseURL: "http://localhost:4174" });
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	if (rate !== 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate });
	return { page, cdp, close: () => context.close() };
}

interface FrameSample {
	/** `performance.now()` at the start of the frame that ended the gap. */
	at: number;
	gap: number;
}

interface FrameRecorder {
	start: () => Promise<void>;
	stop: () => Promise<FrameSample[]>;
}

/** rAF delta sampling, with the frame start time kept for the completion-frame window. */
async function frameRecorder(page: Page): Promise<FrameRecorder> {
	return {
		start: async () => {
			await page.evaluate(() => {
				const target = window as unknown as {
					__frames: [number, number][];
					__framesStop: boolean;
					__frameLast: number;
				};
				target.__frames = [];
				target.__framesStop = false;
				target.__frameLast = performance.now();
				const tick = (now: number) => {
					if (target.__framesStop) return;
					target.__frames.push([now, now - target.__frameLast]);
					target.__frameLast = now;
					requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			});
		},
		stop: async () => {
			const values = await page.evaluate(() => {
				const target = window as unknown as { __frames: [number, number][]; __framesStop: boolean };
				target.__framesStop = true;
				return target.__frames;
			});
			return values.slice(1).map(([at, gap]) => ({ at, gap }));
		},
	};
}

/** The largest frame gap that overlaps the [from, to] window, in ms. */
function worstFrameBetween(frames: FrameSample[], from: number, to: number): number {
	const window = frames.filter((frame) => frame.at >= from && frame.at <= to);
	return window.length === 0 ? 0 : Math.max(...window.map((frame) => frame.gap));
}

function gapSummary(gaps: number[]): { count: number; over50: number; p95: number; max: number; fps: number } {
	const total = gaps.reduce((sum, gap) => sum + gap, 0);
	return {
		count: gaps.length,
		over50: gaps.filter((gap) => gap > 50).length,
		p95: percentile(gaps, 95),
		max: gaps.length === 0 ? 0 : Math.max(...gaps),
		fps: total > 0 ? (gaps.length / total) * 1000 : 0,
	};
}

function logFrames(label: string, rate: number, summary: ReturnType<typeof gapSummary>): void {
	console.log(
		`${label} @${rate}x: ${summary.count} frames, ${summary.over50} >50 ms, p95 ${round(summary.p95)} ms, max ${round(summary.max)} ms, ${round(summary.fps)} fps`,
	);
}

// --- 1. entry bundle -------------------------------------------------------

test("entry bundle is within the 250 kB gzip budget", () => {
	const dist = new URL("../../dist/", import.meta.url);
	const html = readFileSync(new URL("index.html", dist), "utf8");
	const entry = /<script type="module"[^>]*src="\/(assets\/index-[^"]+)"/.exec(html)?.[1];
	expect(entry, "the built index.html names its entry chunk").toBeTruthy();
	const bytes = readFileSync(new URL(entry as string, dist));
	const gzip = gzipSync(bytes).length;
	record("entry-bundle-gzip", 0, [gzip / 1000], `raw ${bytes.length} bytes`);
	expect(gzip).toBeLessThanOrEqual(250_000);
});

// --- 2. session list, 100,000 sessions -------------------------------------

function manySessions(count: number) {
	const base = Date.UTC(2026, 0, 1);
	const sessions = Array.from({ length: count }, (_, index) =>
		sessionListItem({
			id: `s-${index + 1}`,
			title: `Session ${index + 1}`,
			updatedAt: new Date(base - index * 60_000).toISOString(),
		}),
	);
	return { sessions, details: {}, events: {} };
}

interface ResourcePhase {
	name: string;
	start: number;
	end: number;
}

interface FirstScreen {
	/** Time from navigation to the frame *after* the one that first painted a session row. */
	wall: number;
	/** Time from navigation to the frame that first saw the row in the DOM. */
	rowInDom: number;
	afterResponse: number;
	fcp: number | undefined;
	phases: ResourcePhase[];
}

/**
 * The first screen measured strictly: navigation start → the first painted
 * session row, on the wall clock, with every startup request's window from the
 * Performance API. The row is detected on one animation frame and the time is
 * taken on the next one, so the paint of the row has happened.
 */
async function listFirstRender(browser: Browser, rate: number): Promise<FirstScreen> {
	const { page, close } = await throttledPage(browser, rate);
	try {
		await page.addInitScript(() => {
			const target = window as unknown as { __perfFirstRow?: number; __perfRowInDom?: number };
			let seen = false;
			const tick = () => {
				if (!seen && document.querySelector("[data-session-id]") !== null) {
					seen = true;
					target.__perfRowInDom = performance.now();
					// The browser paints between this frame and the next one.
					requestAnimationFrame(() => {
						target.__perfFirstRow ??= performance.now();
					});
					return;
				}
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		await mockApi(page, { loggedIn: true, latencyMs: 50, state: manySessions(100_000) });
		await page.goto("/sessions");
		await page.waitForFunction(() => (window as unknown as { __perfFirstRow?: number }).__perfFirstRow !== undefined, {
			timeout: 120_000,
		});
		const measured = await page.evaluate(() => {
			const target = window as unknown as { __perfFirstRow?: number; __perfRowInDom?: number };
			const firstRow = target.__perfFirstRow ?? performance.now();
			const rowInDom = target.__perfRowInDom ?? firstRow;
			const listEntries = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
				.filter((entry) => entry.name.includes("/api/sessions?"))
				.sort((a, b) => a.startTime - b.startTime);
			const list = listEntries[0];
			const phaseName = (name: string): string | undefined => {
				if (name.includes("/api/me")) return "me";
				if (name.includes("/api/sessions?")) return "list";
				if (name.includes("/api/models")) return "models";
				if (/\/assets\/index-[^/]+\.js$/.test(name)) return "entry";
				if (/\/assets\/(en|zh-CN)-[^/]+\.js$/.test(name)) return "catalog";
				if (name.includes("/assets/sessions-layout-")) return "layout";
				if (name.includes("/assets/pages-")) return "page";
				return undefined;
			};
			const seen = new Set<string>();
			const phases: { name: string; start: number; end: number }[] = [];
			const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
			if (navigation) phases.push({ name: "html", start: navigation.startTime, end: navigation.responseEnd });
			for (const entry of (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).sort(
				(a, b) => a.startTime - b.startTime,
			)) {
				const name = phaseName(entry.name);
				if (name === undefined || seen.has(name)) continue;
				seen.add(name);
				phases.push({ name, start: entry.startTime, end: entry.responseEnd });
			}
			const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
			return {
				firstRow,
				rowInDom,
				listEnd: list?.responseEnd ?? firstRow,
				fcp,
				phases: phases.sort((a, b) => a.start - b.start),
			};
		});
		return {
			wall: measured.firstRow,
			rowInDom: measured.rowInDom,
			afterResponse: measured.firstRow - measured.listEnd,
			fcp: measured.fcp,
			phases: measured.phases,
		};
	} finally {
		await close();
	}
}

function phaseText(phases: ResourcePhase[]): string {
	return phases.map((phase) => `${phase.name} ${round(phase.start)}–${round(phase.end)}`).join(", ");
}

test("session list of 100,000 sessions: first render and scrolling frames", async ({ browser }) => {
	for (const rate of [1, 4]) {
		const walls: number[] = [];
		const afterResponse: number[] = [];
		const minusMock: number[] = [];
		const runs: FirstScreen[] = [];
		for (let run = 0; run < RUNS; run++) {
			const sample = await listFirstRender(browser, rate);
			runs.push(sample);
			walls.push(sample.wall);
			afterResponse.push(sample.afterResponse);
			minusMock.push(sample.wall - 50);
			console.log(
				`first-screen @${rate}x run ${run + 1}: row in DOM ${round(sample.rowInDom)} ms, painted ${round(sample.wall)} ms, FCP ${round(sample.fcp ?? 0)} ms; ${phaseText(sample.phases)}`,
			);
		}
		const sorted = [...runs].sort((a, b) => a.wall - b.wall);
		const medianRun = sorted[Math.floor(sorted.length / 2)] as FirstScreen;
		record(
			"session-list-100k-first-render-total",
			rate,
			walls,
			`nav → first painted row, wall clock incl. the mocked latency; row in DOM ${round(medianRun.rowInDom)} ms, FCP ${round(medianRun.fcp ?? 0)} ms; ${phaseText(medianRun.phases)}`,
		);
		record(
			"session-list-100k-first-render-render",
			rate,
			afterResponse,
			"from the list response to the first painted row",
		);
		record("session-list-100k-first-render-excl-mock", rate, minusMock, "wall clock minus one 50 ms mocked response");

		const gaps: number[] = [];
		const { page, close } = await throttledPage(browser, rate);
		try {
			await mockApi(page, { loggedIn: true, latencyMs: 50, state: manySessions(100_000) });
			await page.goto("/sessions");
			const scroller = page.getByTestId("session-list-scroller");
			await expect(page.locator("[data-session-id]").first()).toBeVisible({ timeout: 120_000 });
			await scroller.hover();
			const recorder = await frameRecorder(page);
			await recorder.start();
			const until = Date.now() + 10_000;
			while (Date.now() < until) {
				await page.mouse.wheel(0, 900);
				await page.waitForTimeout(30);
			}
			gaps.push(...(await recorder.stop()).map((frame) => frame.gap));
		} finally {
			await close();
		}
		const summary = gapSummary(gaps);
		logFrames("session-list-100k-scroll", rate, summary);
		results[`session-list-100k-scroll-frames@${rate}`] = {
			throttle: rate,
			reps: [round(summary.p95)],
			notes: `${summary.count} frames, ${summary.over50} gaps >50 ms, p95 ${round(summary.p95)} ms, max ${round(summary.max)} ms, avg ${round(summary.fps)} fps`,
		};
	}
});

// --- 3. transcript, 20,000 messages ----------------------------------------

function transcriptFixture() {
	const items = makeTranscript(20_000);
	const view = sessionView(sessionListItem({ id: "s1", title: "Big transcript" }));
	return {
		sessions: [sessionListItem({ id: "s1", title: "Big transcript" })],
		details: { s1: view },
		events: { s1: snapshotEvent(items, "h1") },
		olderEntries: { s1: { entries: makeTranscript(100, "o"), historyCursor: null } },
	};
}

async function transcriptRun(browser: Browser, rate: number) {
	const { page, close } = await throttledPage(browser, rate);
	try {
		const api = await mockApi(page, { loggedIn: true, latencyMs: 50, state: transcriptFixture() });
		await page.goto("/sessions");
		await openSession(page, api, "s1");
		const scroller = page.getByTestId("transcript-scroller");
		await expect(scroller).toHaveAttribute("data-loaded-count", "20000", { timeout: 180_000 });
		const before = await scroller.getAttribute("data-loaded-count");

		const counts: number[] = [];
		for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
			await scroller.evaluate((element, part) => {
				element.scrollTop = (element.scrollHeight - element.clientHeight) * part;
			}, fraction);
			await page.waitForTimeout(300);
			counts.push(await page.evaluate(() => document.querySelectorAll("*").length));
		}
		const nodeSpread = Math.max(...counts) - Math.min(...counts);

		// Scrolling to the top above already requested the older page; it must have arrived.
		await expect(scroller).not.toHaveAttribute("data-loaded-count", before ?? "", { timeout: 30_000 });
		await page.waitForTimeout(600);
		const drift = await page.evaluate(() => {
			const element = document.querySelector<HTMLElement>('[data-testid="transcript-scroller"]');
			const id = element?.dataset.prependAnchorId;
			const top = Number(element?.dataset.prependAnchorTop ?? Number.NaN);
			if (!element || id === undefined || !Number.isFinite(top)) return Number.NaN;
			const row = element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
			return row === null ? Number.NaN : Math.abs(row.getBoundingClientRect().top - top);
		});

		await scroller.hover();
		const recorder = await frameRecorder(page);
		await recorder.start();
		const until = Date.now() + 5_000;
		while (Date.now() < until) {
			await page.mouse.wheel(0, -700);
			await page.waitForTimeout(30);
		}
		const gaps = await recorder.stop();
		return { nodeSpread, drift, gaps: gapSummary(gaps.map((frame) => frame.gap)) };
	} finally {
		await close();
	}
}

test("transcript of 20,000 messages: flat DOM, prepend drift and scrolling frames", async ({ browser }) => {
	for (const rate of [1, 4]) {
		const spreads: number[] = [];
		const drifts: number[] = [];
		const worst: number[] = [];
		const p95s: number[] = [];
		const over50 = { total: 0, gaps: 0 };
		let last: ReturnType<typeof gapSummary> | undefined;
		for (let run = 0; run < RUNS; run++) {
			const sample = await transcriptRun(browser, rate);
			spreads.push(sample.nodeSpread);
			drifts.push(sample.drift);
			worst.push(sample.gaps.max);
			p95s.push(sample.gaps.p95);
			over50.total += sample.gaps.count;
			over50.gaps += sample.gaps.over50;
			last = sample.gaps;
		}
		record("transcript-20k-dom-node-spread", rate, spreads, "max − min DOM nodes across scroll positions");
		record("transcript-20k-prepend-drift", rate, drifts, "reading-position drift after loading older history, px");
		record("transcript-20k-scroll-p95", rate, p95s);
		record(
			"transcript-20k-scroll-worst-frame",
			rate,
			worst,
			`${over50.gaps}/${over50.total} frame gaps >50 ms across the runs`,
		);
		logFrames("transcript-20k-scroll (worst frame per run)", rate, last as ReturnType<typeof gapSummary>);
	}
});

// --- 4. streaming at realistic rates ---------------------------------------

const FIXTURES = new URL("../../src/markdown/__fixtures__/", import.meta.url);

function fixtureText(chars: number): string {
	const text = readFileSync(new URL("doc-100k.md", FIXTURES), "utf8");
	if (text.length >= chars) return text.slice(0, chars);
	return text + text.repeat(Math.ceil((chars - text.length) / text.length)).slice(0, chars - text.length);
}

interface StreamResult {
	samples: number[];
	p95: number;
	max: number;
	busyShare: number;
	gaps: ReturnType<typeof gapSummary>;
	/** The worst frame gap within [message_end − 20 ms, message_end + 2 s]. */
	completionFrame: number;
}

async function streamRun(
	browser: Browser,
	throttleRate: number,
	charsPerSecond: number,
	chars: number,
): Promise<StreamResult> {
	const text = fixtureText(chars);
	const { page, cdp, close } = await throttledPage(browser, throttleRate);
	try {
		await mockApi(page, {
			loggedIn: true,
			latencyMs: 50,
			state: {
				sessions: [sessionListItem({ id: "s1", title: "Streaming" })],
				details: { s1: sessionView(sessionListItem({ id: "s1", title: "Streaming" })) },
				events: { s1: snapshotEvent([userEntry("u1", "show me the incident brief")], null) },
			},
		});
		await page.goto("/sessions");
		await page.locator('[data-session-id="s1"]').click();
		await page.waitForFunction(
			() => window.__crhSseSources?.some((source) => source.url.includes("/sessions/s1/events")) === true,
		);
		await page.evaluate(
			(events) => window.__crhEmitSse?.("/sessions/s1/events", "events", events),
			[
				{
					type: "snapshot",
					snapshot: {
						entries: [userEntry("u1", "show me the incident brief")],
						tools: [],
						inbox: [],
						historyCursor: null,
					},
				},
			],
		);
		await expect(page.getByTestId("composer-input")).toBeVisible();

		await page.evaluate(() => {
			const target = window as unknown as { __clickLatencies: number[] };
			target.__clickLatencies = [];
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries() as PerformanceEventTiming[]) {
					if (entry.name === "click") target.__clickLatencies.push(entry.processingStart - entry.startTime);
				}
			}).observe({ type: "event", buffered: true, durationThreshold: 16 });
		});

		await cdp.send("Performance.enable");
		const before = await cdp.send("Performance.getMetrics");
		const recorder = await frameRecorder(page);
		await recorder.start();

		await page.evaluate(
			({ text, rate }) => {
				type Source = { url: string; closed: boolean; dispatch: (name: string, event: { data?: string }) => void };
				const target = window as unknown as {
					__crhSseSources?: Source[];
					__streamDone?: boolean;
					__streamDoneAt?: number;
				};
				target.__streamDone = false;
				target.__streamDoneAt = undefined;
				const sources = (target.__crhSseSources ?? []).filter(
					(source) => source.url.includes("/sessions/s1/events") && !source.closed,
				);
				const send = (events: unknown[]) => {
					for (const source of sources) source.dispatch("events", { data: JSON.stringify(events) });
				};
				send([
					{ type: "run_start", inputs: [] },
					{ type: "message_start", message: { role: "assistant", content: [] } },
					{
						type: "message_update",
						changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }],
					},
				]);
				const startedAt = performance.now();
				let sent = 0;
				const timer = setInterval(() => {
					if (target.__streamDone === true) return;
					const wanted = Math.min(text.length, Math.floor(((performance.now() - startedAt) / 1000) * rate));
					if (wanted > sent) {
						send([
							{
								type: "message_update",
								changes: [{ type: "text_delta", contentIndex: 0, delta: text.slice(sent, wanted) }],
							},
						]);
						sent = wanted;
					}
					if (sent >= text.length) {
						clearInterval(timer);
						target.__streamDoneAt = performance.now();
						send([
							{
								type: "message_end",
								entry: {
									id: "a1",
									kind: "pi.assistant",
									model: [{ role: "assistant", content: [{ type: "text", text }] }],
								},
							},
							{ type: "run_end", inputs: [] },
						]);
						target.__streamDone = true;
					}
				}, 100);
			},
			{ text, rate: charsPerSecond },
		);

		const expectedMs = (chars / charsPerSecond) * 1000;
		const interval = Math.max(1_500, expectedMs / 10);
		const stop = page.locator('[data-slot="composer"]').getByRole("button", { name: "Stop" });
		const clickUntil = Date.now() + expectedMs;
		while (Date.now() < clickUntil) {
			await page.waitForTimeout(interval);
			if (await stop.isVisible().catch(() => false)) {
				await stop.click({ timeout: 5_000 }).catch(() => undefined);
			}
			const done = await page.evaluate(() => (window as unknown as { __streamDone?: boolean }).__streamDone === true);
			if (done) break;
		}
		await page.waitForFunction(() => (window as unknown as { __streamDone?: boolean }).__streamDone === true, {
			timeout: Math.max(60_000, expectedMs),
		});
		await page.waitForTimeout(500);
		const frames = await recorder.stop();
		const gaps = gapSummary(frames.map((frame) => frame.gap));
		const doneAt = await page.evaluate(
			() => (window as unknown as { __streamDoneAt?: number }).__streamDoneAt ?? Number.NaN,
		);
		const completionFrame = Number.isFinite(doneAt) ? worstFrameBetween(frames, doneAt - 20, doneAt + 2_000) : 0;
		const after = await cdp.send("Performance.getMetrics");
		const metric = (list: Metrics, name: string) => list.find((entry) => entry.name === name)?.value ?? 0;
		const taskSeconds =
			metric(after.metrics as Metrics, "TaskDuration") - metric(before.metrics as Metrics, "TaskDuration");
		const elapsedSeconds =
			metric(after.metrics as Metrics, "Timestamp") - metric(before.metrics as Metrics, "Timestamp");
		const samples = await page.evaluate(() => (window as unknown as { __clickLatencies: number[] }).__clickLatencies);
		return {
			samples,
			p95: percentile(samples, 95),
			max: samples.length === 0 ? 0 : Math.max(...samples),
			busyShare: elapsedSeconds > 0 ? Math.min(1, taskSeconds / elapsedSeconds) : 0,
			gaps,
			completionFrame,
		};
	} finally {
		await close();
	}
}

test("streaming at 1,500 and 300 characters per second: Stop latency and frames", async ({ browser }) => {
	for (const rate of [1, 4]) {
		for (const [label, perSecond, fullChars] of [
			["1500cps-100k", 1_500, 100_000],
			["300cps-30k", 300, 30_000],
		] as const) {
			const chars = Math.max(1_000, Math.round(fullChars * STREAM_SCALE));
			const p95s: number[] = [];
			const maxes: number[] = [];
			const busy: number[] = [];
			const worst: number[] = [];
			const completion: number[] = [];
			const sampleCounts: number[] = [];
			for (let run = 0; run < RUNS; run++) {
				const result = await streamRun(browser, rate, perSecond, chars);
				p95s.push(result.p95);
				maxes.push(result.max);
				busy.push(result.busyShare * 100);
				worst.push(result.gaps.max);
				completion.push(result.completionFrame);
				sampleCounts.push(result.samples.length);
			}
			record(`stream-${label}-stop-latency-p95`, rate, p95s, `samples per run: ${sampleCounts.join("/")}`);
			record(`stream-${label}-stop-latency-max`, rate, maxes);
			record(`stream-${label}-worst-frame`, rate, worst);
			record(
				`stream-${label}-completion-frame`,
				rate,
				completion,
				"worst rAF gap at message_end (the completion transition)",
			);
			record(`stream-${label}-main-thread-busy`, rate, busy, "% of the streaming wall time");
		}
	}
});

// --- 5. a completed long message remounting ---------------------------------

const REMOUNT_FILLER = 80;

/**
 * A transcript whose second row is a full 100K Markdown message, followed by
 * enough short rows that the long one is outside the virtual window at the
 * bottom. Opening the session lands at the bottom, then the test scrolls back
 * up until the long row is mounted again.
 */
function remountFixture() {
	const entries = [
		userEntry("u0", "read the runbook"),
		assistantEntry("long", fixtureText(100_000)),
		...makeTranscript(REMOUNT_FILLER, "m"),
	];
	const view = sessionView(sessionListItem({ id: "s1", title: "Long message" }));
	return {
		sessions: [sessionListItem({ id: "s1", title: "Long message" })],
		details: { s1: view },
		events: { s1: snapshotEvent(entries, null) },
		entryCount: entries.length,
	};
}

/** Scroll upwards in steps until `row` is mounted (and stop there). */
async function scrollUntilVisible(
	page: Page,
	scroller: ReturnType<Page["getByTestId"]>,
	row: ReturnType<Page["locator"]>,
) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 30_000) {
		await scroller.evaluate((element) => {
			element.scrollTop = Math.max(0, element.scrollTop - 800);
		});
		await page.waitForTimeout(40);
		if ((await row.count()) > 0) return;
	}
}

async function remountRun(browser: Browser, rate: number): Promise<ReturnType<typeof gapSummary>> {
	const { page, close } = await throttledPage(browser, rate);
	try {
		const state = remountFixture();
		const api = await mockApi(page, { loggedIn: true, latencyMs: 50, state });
		await page.goto("/sessions");
		await openSession(page, api, "s1");
		const scroller = page.getByTestId("transcript-scroller");
		await expect(scroller).toHaveAttribute("data-loaded-count", String(state.entryCount), { timeout: 180_000 });
		const row = page.locator('[data-message-id="long/0"]');
		// The list settles at the bottom; the long row is far above the window then.
		await expect(row).toHaveCount(0, { timeout: 30_000 });
		await scroller.hover();
		// Warm the page caches: scroll the row into view once, then back to the
		// bottom so that what is measured below is the second, cached mount.
		await scrollUntilVisible(page, scroller, row);
		await page.waitForTimeout(1_000);
		await scroller.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(row).toHaveCount(0, { timeout: 30_000 });
		const recorder = await frameRecorder(page);
		await recorder.start();
		await scrollUntilVisible(page, scroller, row);
		await page.waitForTimeout(800);
		return gapSummary((await recorder.stop()).map((frame) => frame.gap));
	} finally {
		await close();
	}
}

test("a completed 100K message scrolling back into the window does not hitch", async ({ browser }) => {
	for (const rate of [1, 4]) {
		const worst: number[] = [];
		for (let run = 0; run < RUNS; run++) {
			const summary = await remountRun(browser, rate);
			worst.push(summary.max);
			logFrames("transcript-100k-remount", rate, summary);
		}
		record(
			"transcript-100k-remount-worst-frame",
			rate,
			worst,
			"worst rAF gap of the second mount of the completed 100K row, after scrolling it out of and back into the virtual window",
		);
	}
});

// --- results ---------------------------------------------------------------

/** The JSON in the shape `biome format` produces: tabs, and primitive arrays on one line. */
function jsonReport(): string {
	const keys = Object.keys(results);
	const lines = ["{"];
	keys.forEach((key, index) => {
		const entry = results[key] as Entry;
		const comma = index === keys.length - 1 ? "" : ",";
		const hasNotes = entry.notes !== undefined;
		lines.push(`\t${JSON.stringify(key)}: {`);
		lines.push(`\t\t"throttle": ${entry.throttle},`);
		lines.push(`\t\t"reps": [${entry.reps.join(", ")}]${hasNotes ? "," : ""}`);
		if (hasNotes) lines.push(`\t\t"notes": ${JSON.stringify(entry.notes)}`);
		lines.push(`\t}${comma}`);
	});
	lines.push("}");
	return `${lines.join("\n")}\n`;
}

/** A GFM table padded the way `biome format` prints it. */
function table(header: string[], rows: string[][]): string[] {
	const widths = header.map((title, index) =>
		Math.max(title.length, ...rows.map((row) => (row[index] as string).length)),
	);
	const line = (cells: string[]) =>
		`| ${cells.map((cell, index) => cell.padEnd(widths[index] as number)).join(" | ")} |`;
	return [line(header), `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`, ...rows.map(line)];
}

test.afterAll(() => {
	const out = new URL("./", import.meta.url);
	writeFileSync(new URL("results.json", out), jsonReport());

	const value = (key: string, throttle: number): number | undefined => {
		const entry = results[`${key}@${throttle}`];
		return entry === undefined ? undefined : median(entry.reps);
	};
	const rows: [string, string, string, string][] = [
		["entry bundle, gzip", "entry-bundle-gzip", "kB", "≤ 250 kB"],
		["list 100k: first render, wall", "session-list-100k-first-render-total", "ms", "report both"],
		[
			"list 100k: first render, after list response",
			"session-list-100k-first-render-render",
			"ms",
			"< 200 ms at 4× (excl. mock latency)",
		],
		["list 100k: first render, minus 50 ms mock", "session-list-100k-first-render-excl-mock", "ms", "< 200 ms at 4×"],
		["list 100k: scroll 10 s, p95 frame gap", "session-list-100k-scroll-frames", "ms", "no visible jank"],
		["transcript 20k: DOM node spread", "transcript-20k-dom-node-spread", "", "flat"],
		["transcript 20k: prepend anchor drift", "transcript-20k-prepend-drift", "px", "≤ 2 px"],
		["transcript 20k: scroll, p95 frame gap", "transcript-20k-scroll-p95", "ms", "no visible jank"],
		["transcript 20k: scroll, worst frame", "transcript-20k-scroll-worst-frame", "ms", ""],
		[
			"transcript 100K: remount, worst frame",
			"transcript-100k-remount-worst-frame",
			"ms",
			"regression guard (was 667 ms)",
		],
		["stream 1,500 c/s 100K: Stop p95", "stream-1500cps-100k-stop-latency-p95", "ms", "< 100 ms at 4×"],
		["stream 1,500 c/s 100K: Stop max", "stream-1500cps-100k-stop-latency-max", "ms", ""],
		["stream 1,500 c/s 100K: worst frame", "stream-1500cps-100k-worst-frame", "ms", ""],
		["stream 1,500 c/s 100K: completion frame", "stream-1500cps-100k-completion-frame", "ms", "not the worst frame"],
		["stream 1,500 c/s 100K: main-thread busy", "stream-1500cps-100k-main-thread-busy", "%", ""],
		["stream 300 c/s 30K: Stop p95", "stream-300cps-30k-stop-latency-p95", "ms", "< 100 ms at 4×"],
		["stream 300 c/s 30K: Stop max", "stream-300cps-30k-stop-latency-max", "ms", ""],
		["stream 300 c/s 30K: worst frame", "stream-300cps-30k-worst-frame", "ms", ""],
		["stream 300 c/s 30K: completion frame", "stream-300cps-30k-completion-frame", "ms", "not the worst frame"],
		["stream 300 c/s 30K: main-thread busy", "stream-300cps-30k-main-thread-busy", "%", ""],
	];
	const cells: string[][] = [];
	for (const [label, key, unit, target] of rows) {
		const one = value(key, 1);
		const four = value(key, 4);
		const zero = value(key, 0);
		const format = (number: number | undefined) => (number === undefined ? "—" : `${round(number)} ${unit}`.trim());
		cells.push([label, format(one ?? zero), format(four), target]);
	}
	const lines = [
		"# WebUI performance results",
		"",
		"Medians of three runs on Chromium against the mocked API (50 ms per response),",
		"at 1× and 4× CPU throttling (`Emulation.setCPUThrottlingRate` via CDP).",
		"Regenerate with `pnpm --filter @crh/web test:perf`; raw medians and notes are in",
		"[results.json](results.json).",
		"",
		...table(["metric", "1×", "4×", "target"], cells),
		"",
	];
	lines.push(
		"",
		"Notes:",
		"- `first render, wall` is the browser's time from navigation to the first painted session row,",
		"  so it includes the mocked responses and all of startup. The row is detected on one animation",
		"  frame and the time is taken on the next one, so the paint has happened; the note also lists the",
		"  Performance API window of every startup request (html, entry chunk, locale catalog, /api/me,",
		"  sessions layout and index chunks, first list page, models). `after list response` runs from the",
		"  end of the cursor response to that paint; `minus 50 ms mock` subtracts one mocked response. The",
		"  first list page is requested as soon as auth resolves, so on the mocked run the response lands",
		"  before the shell has rendered and `after list response` also covers the remaining startup",
		"  render; the strict wall time is the headline number.",
		"- Streaming: the full SafeMarkdown `doc-100k` fixture at 1,500 chars/s, and its first 30K",
		"  characters at 300 chars/s (the brief's allowed variant; 100K at 300 chars/s is ~5.5 min",
		"  per run). Stop latency is the Event Timing input delay (`processingStart - startTime`),",
		"  with clicks spread over the stream.",
		"- `main-thread busy` is CDP `Performance.getMetrics` TaskDuration divided by the streaming",
		"  wall time. `worst frame` is the largest rAF gap while streaming; `completion frame` is the",
		"  largest gap in the two seconds after the final `message_end`, i.e. the transition from the",
		"  incremental streamed render to the committed message.",
		"- `transcript 100K: remount` scrolls a completed 100K message out of and back into the virtual",
		"  window and reports the worst frame of that scroll.",
		"- Transcript scrolling reports the p95 frame gap and the worst frame per run; all raw",
		"  per-run numbers are in results.json.",
	);
	writeFileSync(new URL("RESULTS.md", out), `${lines.join("\n")}\n`);
});
