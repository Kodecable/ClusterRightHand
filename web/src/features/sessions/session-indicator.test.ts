import type { SessionListItem } from "@crh/api";
import { describe, expect, test } from "vitest";
import { type SessionIndicator, sessionIndicator } from "./session-indicator";

/** The three inputs the indicator reads, with everything settled and idle unless a case says otherwise. */
function item(overrides: Partial<Pick<SessionListItem, "state" | "unread" | "jobs">> = {}) {
	return {
		state: "idle" as const,
		unread: false,
		jobs: { active: 0, awaitingUser: 0 },
		...overrides,
	};
}

const attention = (reason: SessionIndicator["reason"]): SessionIndicator => ({ kind: "attention", reason });
const busy = (reason: SessionIndicator["reason"]): SessionIndicator => ({ kind: "busy", reason });

describe("sessionIndicator", () => {
	test.each([
		["idle and all read", item(), null],
		["unread only", item({ unread: true }), { kind: "unread", reason: "unread" }],
		["the tree awaits", item({ state: "awaiting", unread: true }), attention("awaiting")],
		["a job awaits the user", item({ jobs: { active: 1, awaitingUser: 1 }, unread: true }), attention("job-awaiting")],
		[
			"the tree awaits and a job does too",
			item({ state: "awaiting", jobs: { active: 1, awaitingUser: 1 }, unread: true }),
			attention("awaiting"),
		],
		[
			"the tree runs while a job awaits the user",
			item({ state: "running", jobs: { active: 1, awaitingUser: 1 }, unread: true }),
			attention("job-awaiting"),
		],
		[
			"the tree runs and a job awaits the user without being counted active",
			item({ state: "running", jobs: { active: 0, awaitingUser: 1 }, unread: true }),
			attention("job-awaiting"),
		],
		["the tree runs", item({ state: "running", unread: true }), busy("running")],
		[
			"the tree runs with active jobs",
			item({ state: "running", jobs: { active: 2, awaitingUser: 0 }, unread: true }),
			busy("running"),
		],
		["a job runs in an idle tree", item({ jobs: { active: 1, awaitingUser: 0 } }), busy("job-running")],
		["jobs run with unread output", item({ jobs: { active: 3, awaitingUser: 0 }, unread: true }), busy("job-running")],
		[
			"the tree awaits, jobs run and output is unread",
			item({ state: "awaiting", jobs: { active: 2, awaitingUser: 0 }, unread: true }),
			attention("awaiting"),
		],
	])("%s", (_name, input, expected) => {
		expect(sessionIndicator(input)).toEqual(expected);
	});
});
