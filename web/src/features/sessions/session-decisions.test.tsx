import type { ApprovalList, TaskGroupView, TaskView } from "@crh/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { type SessionDecision, SessionDecisionDock, sessionDecisions } from "./session-decisions";

const task = (id: string, createdAt: string, rootSessionId: string | null = "root"): TaskView =>
	({
		id,
		createdAt,
		rootSessionId,
		approval: null,
		kind: "exec",
		summary: `echo ${id}`,
		operation: { method: "exec", target: `echo ${id}` },
		nodeId: "node-1",
		privileged: false,
	}) as TaskView;

const group = (id: string, createdAt: string): TaskGroupView =>
	({ id, createdAt, rootSessionId: "root" }) as TaskGroupView;

const quota = (sessionId: string, since: string) => ({
	sessionId,
	levelId: sessionId,
	title: null,
	since,
	budgetRemaining: 0,
	budgetUsedTokens: 1,
});

const data = (): ApprovalList => ({
	tasks: [task("later", "2026-01-02T00:00:00.000Z"), task("older", "2026-01-01T00:00:00.000Z")],
	taskGroups: [group("group", "2026-01-03T00:00:00.000Z")],
	authorizations: {
		tasks: [task("sign-older", "2026-01-01T00:00:00.000Z"), task("sign-later", "2026-01-02T00:00:00.000Z")],
		taskGroups: [group("sign-group", "2026-01-04T00:00:00.000Z")],
	},
	quotas: [quota("other", "2026-01-01T00:00:00.000Z"), quota("root", "2026-01-02T00:00:00.000Z")],
});

describe("sessionDecisions", () => {
	test("orders quota, approvals, task-group approvals and signatures, oldest first", () => {
		const decisions = sessionDecisions(data(), "root");
		expect(decisions.map((decision) => decision.kind)).toEqual([
			"quota",
			"approval_task",
			"approval_task",
			"approval_task_group",
			"signature_task",
			"signature_task",
			"signature_task_group",
		]);
		expect(decisions[0]).toMatchObject({ kind: "quota", wait: { sessionId: "root" } });
		expect(decisions[1]).toMatchObject({ kind: "approval_task", task: { id: "older" } });
		expect(decisions[2]).toMatchObject({ kind: "approval_task", task: { id: "later" } });
		expect(decisions[4]).toMatchObject({ kind: "signature_task", task: { id: "sign-older" } });
		expect(decisions[5]).toMatchObject({ kind: "signature_task", task: { id: "sign-later" } });
	});

	test("keeps only what belongs to the given session tree", () => {
		const list = data();
		list.tasks.push(task("elsewhere", "2026-01-01T00:00:00.000Z", "another-root"));
		const decisions = sessionDecisions(list, "root");
		expect(decisions.some((decision) => decision.kind === "approval_task" && decision.task.id === "elsewhere")).toBe(
			false,
		);
		expect(decisions.some((decision) => decision.kind === "quota" && decision.wait.sessionId === "other")).toBe(false);
	});

	test("an unloaded approvals list has no decisions", () => {
		expect(sessionDecisions(undefined, "root")).toEqual([]);
	});
});

/** Answers the name lookups the dock's decision components read. */
function mockLookups(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const body =
				path === "/api/nodes"
					? { nodes: [{ id: "node-1", name: "worker-01" }] }
					: path === "/api/node-groups"
						? { groups: [] }
						: path === "/api/api-tokens"
							? { tokens: [] }
							: path === "/api/directory"
								? { users: [], userGroups: [] }
								: {};
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
}

function Harness({ decisions, next }: { decisions: SessionDecision[]; next: SessionDecision[] }) {
	const [current, setCurrent] = useState(decisions);
	return (
		<>
			<button type="button" onClick={() => setCurrent(next)}>
				resolve first
			</button>
			<SessionDecisionDock decisions={current} />
		</>
	);
}

describe("SessionDecisionDock", () => {
	test("shows the first decision, its count, and the next one after it is resolved", async () => {
		mockLookups();
		const first: SessionDecision = { kind: "approval_task", task: task("first", "2026-01-01T00:00:00.000Z") };
		const second: SessionDecision = { kind: "approval_task", task: task("second", "2026-01-02T00:00:00.000Z") };
		await renderWithRouter(<Harness decisions={[first, second]} next={[second]} />);
		const dock = await screen.findByTestId("session-decisions");
		expect(dock).toHaveAttribute("data-decision", "approval_task");
		expect(within(dock).getByTestId("decision-operation")).toHaveTextContent("echo first");
		expect(within(dock).getByText("1 of 2")).toBeInTheDocument();
		expect(within(dock).queryByText("echo second")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "resolve first" }));
		await waitFor(() => expect(within(dock).getByTestId("decision-operation")).toHaveTextContent("echo second"));
		expect(within(dock).queryByText("1 of 2")).not.toBeInTheDocument();
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});
