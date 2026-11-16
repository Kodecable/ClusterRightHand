import type { TaskOutcome } from "@crh/api";
import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { TaskOutcomeBadge, taskOutcomeTone } from "./task-outcome";

const outcome = (overrides: Partial<TaskOutcome>): TaskOutcome => ({ kind: "succeeded", failed: false, ...overrides });

describe("TaskOutcomeBadge", () => {
	test.each<[TaskOutcome, string, string]>([
		[outcome({ kind: "succeeded", failed: false }), "Done", "ok"],
		[outcome({ kind: "succeeded", failed: false, exitCode: 0 }), "Exit code 0", "ok"],
		[outcome({ kind: "exit", failed: true, exitCode: 3 }), "Exit code 3", "danger"],
		[outcome({ kind: "signal", failed: true, signal: "SIGKILL" }), "Killed by signal SIGKILL", "danger"],
		[outcome({ kind: "timed_out", failed: true }), "Timed out", "danger"],
		[outcome({ kind: "cancelled", failed: false }), "Cancelled", "muted"],
		[outcome({ kind: "rejected", failed: true }), "Rejected", "danger"],
		[outcome({ kind: "denied", failed: true }), "Denied by rules", "danger"],
		[
			outcome({ kind: "error", failed: true, errorCode: "node_offline", errorMessage: "gone" }),
			"node_offline: gone",
			"danger",
		],
		[outcome({ kind: "error", failed: true, errorCode: null, errorMessage: null }), "Failed", "danger"],
		[outcome({ kind: "unknown", failed: true }), "Result unknown", "danger"],
	])("renders %j as %s with tone %s", (value, text, tone) => {
		renderWithI18n(<TaskOutcomeBadge outcome={value} />);
		expect(screen.getByTestId("task-outcome")).toHaveTextContent(text);
		expect(screen.getByTestId("task-outcome")).toHaveAttribute("data-tone", tone);
	});

	test("renders nothing without an outcome", () => {
		const { container } = renderWithI18n(<TaskOutcomeBadge outcome={null} />);
		expect(container).toBeEmptyDOMElement();
	});

	test("colours a failed outcome red and a cancelled one muted", () => {
		expect(taskOutcomeTone(outcome({ kind: "exit", failed: true, exitCode: 1 }))).toBe("danger");
		expect(taskOutcomeTone(outcome({ kind: "cancelled", failed: false }))).toBe("muted");
		expect(taskOutcomeTone(outcome({ kind: "succeeded", failed: false }))).toBe("ok");
	});
});
