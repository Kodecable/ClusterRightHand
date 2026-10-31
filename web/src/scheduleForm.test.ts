import { expect, test } from "vitest";
import type { ScheduleRunView, ScheduleView } from "./api.ts";
import {
	defaultTimezone,
	parseScheduleForm,
	presetNote,
	runNote,
	type ScheduleFormState,
	scheduleState,
	stateBadgeKind,
	statusText,
} from "./scheduleForm.ts";

const form = (overrides: Partial<ScheduleFormState> = {}): ScheduleFormState => ({
	name: "nightly check",
	prompt: "Check the nodes",
	model: { provider: "faux", modelId: "faux-model" },
	preset: "ask",
	tokenBudget: "",
	cron: "*/5 * * * *",
	timezone: "Europe/Berlin",
	catchUp: false,
	enabled: true,
	...overrides,
});

test("builds the schedule body, with an empty budget meaning unlimited", () => {
	const parsed = parseScheduleForm(form());
	expect(parsed).toEqual({
		input: {
			name: "nightly check",
			prompt: "Check the nodes",
			model: { provider: "faux", modelId: "faux-model" },
			preset: "ask",
			tokenBudget: null,
			cron: "*/5 * * * *",
			timezone: "Europe/Berlin",
			catchUp: false,
			enabled: true,
		},
	});
	expect(parseScheduleForm(form({ tokenBudget: "2500" }))).toMatchObject({ input: { tokenBudget: 2500 } });
	expect(parseScheduleForm(form({ name: "  trim me  " }))).toMatchObject({ input: { name: "trim me" } });
});

test("rejects a form that is missing its required parts", () => {
	const missing = parseScheduleForm(
		form({ name: " ", prompt: "", model: undefined, cron: "", timezone: "", tokenBudget: "-1" }),
	);
	expect(missing).toHaveProperty("errors");
	if (!("errors" in missing)) throw new Error("expected errors");
	expect(Object.keys(missing.errors).sort()).toEqual(["cron", "model", "name", "prompt", "timezone", "tokenBudget"]);
	// Five fields exactly; the server checks whether the expression and the zone are real.
	expect(parseScheduleForm(form({ cron: "0 0 * * * *" }))).toMatchObject({ errors: { cron: expect.any(String) } });
	expect(parseScheduleForm(form({ name: "x".repeat(201) }))).toMatchObject({ errors: { name: expect.any(String) } });
});

test("a budget of one token is accepted and zero is rejected", () => {
	expect(parseScheduleForm(form({ tokenBudget: "1" }))).toMatchObject({ input: { tokenBudget: 1 } });
	// Zero would make every run fail at submit, so the form refuses it (doc/scheduling.md#授权规则与配额).
	expect(parseScheduleForm(form({ tokenBudget: "0" }))).toMatchObject({
		errors: { tokenBudget: expect.stringContaining("at least 1") },
	});
	expect(parseScheduleForm(form({ tokenBudget: "-3" }))).toMatchObject({ errors: { tokenBudget: expect.any(String) } });
	expect(parseScheduleForm(form({ tokenBudget: "1.5" }))).toMatchObject({
		errors: { tokenBudget: expect.any(String) },
	});
});

test("the last result prefers a run in progress and says never before the first run", () => {
	const schedule = { inProgress: false, lastRun: null } as Pick<ScheduleView, "inProgress" | "lastRun">;
	expect(scheduleState(schedule)).toBe("never");
	expect(scheduleState({ ...schedule, lastRun: { status: "succeeded" } as ScheduleRunView })).toBe("succeeded");
	expect(scheduleState({ inProgress: true, lastRun: { status: "failed" } as ScheduleRunView })).toBe("running");
	expect(stateBadgeKind("succeeded")).toBe("ok");
	expect(stateBadgeKind("failed")).toBe("bad");
	expect(stateBadgeKind("preempted")).toBe("warn");
	expect(stateBadgeKind("running")).toBe("warn");
	expect(stateBadgeKind("never")).toBe("off");
});

test("a run's note shows the reason, and that it was started by hand", () => {
	const run = (overrides: Partial<ScheduleRunView>): ScheduleRunView => ({
		id: "r1",
		scheduleId: "s1",
		fireTime: "2026-01-05T09:00:00.000Z",
		manual: false,
		status: "succeeded",
		sessionId: "a",
		reason: null,
		createdAt: "2026-01-05T09:00:00.000Z",
		startedAt: null,
		finishedAt: null,
		...overrides,
	});
	expect(runNote(run({}))).toBe("finished");
	expect(runNote(run({ status: "failed", reason: "quota denied" }))).toBe("quota denied");
	expect(runNote(run({ manual: true }))).toBe("finished · run by hand");
	expect(runNote(run({ status: "preempted", manual: true }))).toBe("stopped by the next run · run by hand");
	expect(statusText("pending")).toBe("queued");
});

test("the preset note warns that Ask waits on an unattended run", () => {
	expect(presetNote("ask")).toContain("waits for you");
	expect(presetNote("auto_review")).toContain("review model");
	expect(presetNote("yolo")).toContain("without asking");
});

test("the default timezone is an IANA name", () => {
	expect(defaultTimezone()).toMatch(/^[A-Za-z_+-]+(\/[A-Za-z0-9_+-]+)*$/);
});
