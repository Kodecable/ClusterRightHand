import { describe, expect, test } from "vitest";
import type { ScheduleRunView, ScheduleView } from "@/lib/api/types";
import {
	defaultTimezone,
	parseScheduleForm,
	runNoteParts,
	type ScheduleFormState,
	scheduleState,
} from "./scheduleForm";

const form = (overrides: Partial<ScheduleFormState> = {}): ScheduleFormState => ({
	name: "nightly check",
	prompt: "Check the nodes",
	model: { provider: "faux", modelId: "faux-model" },
	thinkingLevel: "off",
	rulePreset: "ask",
	tokenBudget: "",
	cron: "*/5 * * * *",
	timezone: "Europe/Berlin",
	catchUp: false,
	enabled: true,
	...overrides,
});

describe("parseScheduleForm", () => {
	test("builds the schedule body, with an empty budget meaning unlimited", () => {
		expect(parseScheduleForm(form())).toEqual({
			input: {
				name: "nightly check",
				prompt: "Check the nodes",
				model: { provider: "faux", modelId: "faux-model" },
				rulePreset: "ask",
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

	test("keeps an explicit thinking level and omits off", () => {
		expect(parseScheduleForm(form({ thinkingLevel: "high" }))).toEqual({
			input: {
				name: "nightly check",
				prompt: "Check the nodes",
				model: { provider: "faux", modelId: "faux-model", thinkingLevel: "high" },
				rulePreset: "ask",
				tokenBudget: null,
				cron: "*/5 * * * *",
				timezone: "Europe/Berlin",
				catchUp: false,
				enabled: true,
			},
		});
		expect(parseScheduleForm(form({ thinkingLevel: "off" }))).toMatchObject({
			input: { model: { provider: "faux", modelId: "faux-model" } },
		});
	});

	test("validation failures are codes, not sentences", () => {
		expect(parseScheduleForm(form({ name: " " }))).toMatchObject({ errors: { name: "name-required" } });
		expect(parseScheduleForm(form({ name: "x".repeat(201) }))).toMatchObject({ errors: { name: "name-too-long" } });
		expect(parseScheduleForm(form({ prompt: "" }))).toMatchObject({ errors: { prompt: "prompt-required" } });
		expect(parseScheduleForm(form({ model: undefined }))).toMatchObject({ errors: { model: "model-required" } });
		expect(parseScheduleForm(form({ cron: "" }))).toMatchObject({ errors: { cron: "cron-required" } });
		expect(parseScheduleForm(form({ cron: "0 0 * * * *" }))).toMatchObject({ errors: { cron: "cron-five-fields" } });
		expect(parseScheduleForm(form({ timezone: "" }))).toMatchObject({ errors: { timezone: "timezone-required" } });
		expect(parseScheduleForm(form({ tokenBudget: "-1" }))).toMatchObject({
			errors: { tokenBudget: "budget-whole-number" },
		});
		expect(parseScheduleForm(form({ tokenBudget: "0" }))).toMatchObject({ errors: { tokenBudget: "budget-positive" } });
	});

	test("rejects a form that is missing its required parts", () => {
		const missing = parseScheduleForm(
			form({ name: " ", prompt: "", model: undefined, cron: "", timezone: "", tokenBudget: "-1" }),
		);
		expect(missing).toHaveProperty("errors");
		if (!("errors" in missing)) throw new Error("expected errors");
		expect(Object.keys(missing.errors).sort()).toEqual(["cron", "model", "name", "prompt", "timezone", "tokenBudget"]);
		// Five fields exactly; the server checks whether the expression and the zone are real.
		expect(parseScheduleForm(form({ cron: "0 0 * * * *" }))).toMatchObject({
			errors: { cron: expect.any(String) },
		});
		expect(parseScheduleForm(form({ name: "x".repeat(201) }))).toMatchObject({
			errors: { name: expect.any(String) },
		});
	});

	test("a budget of one token is accepted and zero is rejected", () => {
		expect(parseScheduleForm(form({ tokenBudget: "1" }))).toMatchObject({ input: { tokenBudget: 1 } });
		expect(parseScheduleForm(form({ tokenBudget: "0" }))).toMatchObject({
			errors: { tokenBudget: "budget-positive" },
		});
		expect(parseScheduleForm(form({ tokenBudget: "-3" }))).toMatchObject({
			errors: { tokenBudget: expect.any(String) },
		});
		expect(parseScheduleForm(form({ tokenBudget: "1.5" }))).toMatchObject({
			errors: { tokenBudget: expect.any(String) },
		});
	});
});

describe("scheduleState", () => {
	test("prefers a run in progress and says never before the first run", () => {
		const schedule = { inProgress: false, lastRun: null } as Pick<ScheduleView, "inProgress" | "lastRun">;
		expect(scheduleState(schedule)).toBe("never");
		expect(scheduleState({ ...schedule, lastRun: { status: "succeeded" } as ScheduleRunView })).toBe("succeeded");
		expect(scheduleState({ inProgress: true, lastRun: { status: "failed" } as ScheduleRunView })).toBe("running");
	});
});

describe("rule preset notes and run notes", () => {
	test("a run's parts expose the reason and the manual flag", () => {
		const run: ScheduleRunView = {
			id: "r1",
			scheduleId: "s1",
			fireTime: "2026-01-05T09:00:00.000Z",
			manual: true,
			status: "failed",
			sessionId: "a",
			reason: "quota denied",
			createdAt: "2026-01-05T09:00:00.000Z",
			startedAt: null,
			finishedAt: null,
		};
		expect(runNoteParts(run)).toEqual({ status: "failed", reason: "quota denied", manual: true });
	});

	test("the default timezone is an IANA name", () => {
		expect(defaultTimezone()).toMatch(/^[A-Za-z_+-]+(\/[A-Za-z0-9_+-]+)*$/);
	});
});
