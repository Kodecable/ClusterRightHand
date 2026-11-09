import type { TaskGroupView, TaskView } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { TaskGroupResult } from "./task-group-result";

const task = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: "uptime",
		operation: null,
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: null,
		state: "running",
		exitCode: null,
		signal: null,
		timedOut: false,
		cancelled: false,
		errorCode: null,
		errorMessage: null,
		outputBytes: 0,
		outputHead: "",
		outputTail: "",
		outputTailLines: 0,
		outputLines: null,
		notice: null,
		outputFile: null,
		outputMode: "status",
		privileged: false,
		result: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		...overrides,
	}) as TaskView;

const group = (overrides: Partial<TaskGroupView> = {}): TaskGroupView =>
	({
		id: "group-1",
		state: "running",
		targets: ["node-1"],
		nodeIds: ["node-1"],
		parallel: 1,
		failFast: false,
		outputMode: "status",
		privileged: false,
		skipped: [],
		tasks: [task()],
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		...overrides,
	}) as TaskGroupView;

function Harness({
	initial,
	done,
	names,
}: {
	initial: TaskGroupView;
	done: TaskGroupView;
	names: Map<string, string>;
}) {
	const [current, setCurrent] = useState(initial);
	return (
		<>
			<button type="button" onClick={() => setCurrent(done)}>
				finish
			</button>
			<TaskGroupResult taskGroup={current} names={names} />
		</>
	);
}

async function renderResult(element: React.ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const body = url.startsWith("/api/nodes")
				? { nodes: [] }
				: url.startsWith("/api/node-groups")
					? { groups: [] }
					: url.startsWith("/api/api-tokens")
						? { tokens: [] }
						: { ok: true };
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		}),
	);
	const result = await renderWithRouter(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
	return { ...result, client };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("TaskGroupResult", () => {
	test("the per-node grid follows the tasks as they finish", async () => {
		const names = new Map([["node-1", "worker-01"]]);
		const done = group({
			state: "finished",
			finishedAt: "2026-01-01T00:01:00.000Z",
			tasks: [task({ state: "exited", exitCode: 0, finishedAt: "2026-01-01T00:01:00.000Z" })],
		});
		await renderResult(<Harness initial={group()} done={done} names={names} />);
		let row = screen.getByTestId("task-group-member");
		expect(within(row).getByText("worker-01")).toBeInTheDocument();
		expect(within(row).getAllByText("Running").length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole("button", { name: "finish" }));
		row = screen.getByTestId("task-group-member");
		expect(within(row).getAllByText("Finished").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Finished").length).toBeGreaterThan(0);
	});

	test("skipped nodes are named", async () => {
		await renderResult(
			<TaskGroupResult
				taskGroup={group({ state: "interrupted", skipped: ["node-1"] })}
				names={new Map([["node-1", "worker-01"]])}
			/>,
		);
		expect(screen.getByText(/Skipped: worker-01/)).toBeInTheDocument();
		expect(screen.getByText(/the batch was interrupted/)).toBeInTheDocument();
	});

	test("a cancelled group has its own badge and says so under the skipped nodes", async () => {
		await renderResult(
			<TaskGroupResult
				taskGroup={group({ state: "cancelled", skipped: ["node-1"] })}
				names={new Map([["node-1", "worker-01"]])}
			/>,
		);
		expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
		expect(screen.getByText(/the batch was cancelled/)).toBeInTheDocument();
	});

	test("targets are named through refs, including deleted and _all", async () => {
		await renderResult(
			<TaskGroupResult
				taskGroup={group({
					state: "finished",
					targets: ["node-1", "group-1", "gone", "_all"],
					refs: {
						"node-1": { kind: "node", name: "worker-01" },
						"group-1": { kind: "node_group", name: "web" },
						gone: null,
					},
				})}
				names={new Map([["node-1", "worker-01"]])}
			/>,
		);
		const targets = screen.getByTestId("task-group-targets");
		expect(within(targets).getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/nodes/node-1");
		expect(within(targets).getByRole("link", { name: "web" })).toHaveAttribute("href", "/node-groups/group-1");
		expect(within(targets).getByText("Deleted node or node group")).toBeInTheDocument();
		expect(within(targets).getByText("All accessible nodes")).toBeInTheDocument();
	});
});
