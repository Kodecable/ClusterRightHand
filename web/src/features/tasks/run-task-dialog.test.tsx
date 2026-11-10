import type { NodeGroup, PublicNode } from "@crh/api";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { RunTaskDialog } from "./run-task-dialog";

const NODES: PublicNode[] = [
	{
		id: "node-1",
		name: "worker-01",
		transport: "client",
		status: "active",
		hostname: "worker-01.local",
		clientVersion: null,
		privilegedMode: null,
		lastSeenAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		approvedAt: null,
		nodeGroups: [],
		access: "admin",
		facts: null,
		keyFingerprint: null,
		connected: true,
		clockWarning: null,
		trustWarnings: [],
	},
	{
		id: "node-2",
		name: "worker-02",
		transport: "client",
		status: "active",
		hostname: "worker-02.local",
		clientVersion: null,
		privilegedMode: null,
		lastSeenAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		approvedAt: null,
		nodeGroups: [],
		access: "admin",
		facts: null,
		keyFingerprint: null,
		connected: true,
		clockWarning: null,
		trustWarnings: [],
	},
];

const GROUPS: NodeGroup[] = [{ id: "group-1", name: "web", memberIds: ["node-1"] }];

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function mockFetch(): { calls: Call[] } {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url, method, body });
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (url === "/api/nodes") return json({ nodes: NODES });
			if (url === "/api/node-groups") return json({ groups: GROUPS });
			if (url === "/api/nodes/node-1/tasks" && method === "POST") return json({ task: { id: "task-1" } });
			if (url === "/api/task-groups" && method === "POST") return json({ taskGroup: { id: "group-1" } });
			return json({});
		}),
	);
	return { calls };
}

function created(calls: Call[], url: string): Call | undefined {
	return calls.find((call) => call.url === url && call.method === "POST");
}

async function renderDialog() {
	const mocked = mockFetch();
	const onClose = vi.fn();
	const result = await renderWithRouter(<RunTaskDialog onClose={onClose} />);
	return { ...mocked, onClose, ...result };
}

async function pickTarget(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<void> {
	await user.click(screen.getByRole("combobox", { name: "Nodes or node groups" }));
	await user.click(await screen.findByRole("option", { name }));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("RunTaskDialog targets", () => {
	test("exactly one node creates a single task and opens it", async () => {
		const { calls, onClose, router } = await renderDialog();
		const user = userEvent.setup();

		await pickTarget(user, /worker-01/);
		await user.keyboard("{Escape}");
		await user.type(screen.getByRole("textbox", { name: "Shell command" }), "uptime");
		await user.click(screen.getByRole("button", { name: /^Run$/ }));

		await waitFor(() => expect(created(calls, "/api/nodes/node-1/tasks")).toBeDefined());
		expect(created(calls, "/api/task-groups")).toBeUndefined();
		expect(created(calls, "/api/nodes/node-1/tasks")?.body).toMatchObject({
			kind: "exec",
			shell: "uptime",
			waitMs: 0,
		});
		await waitFor(() => expect(router.state.location.pathname).toBe("/tasks/task-1"));
		expect(onClose).toHaveBeenCalled();
	});

	test("a node group creates a task group and opens it", async () => {
		const { calls, onClose, router } = await renderDialog();
		const user = userEvent.setup();

		await pickTarget(user, /web/);
		await user.keyboard("{Escape}");
		await user.type(screen.getByRole("textbox", { name: "Shell command" }), "uptime");
		await user.click(screen.getByRole("button", { name: /^Run$/ }));

		await waitFor(() => expect(created(calls, "/api/task-groups")).toBeDefined());
		expect(created(calls, "/api/task-groups")?.body).toMatchObject({ targets: ["web"], shell: "uptime" });
		await waitFor(() => expect(router.state.location.pathname).toBe("/task-groups/group-1"));
		expect(onClose).toHaveBeenCalled();
	});

	test("two nodes create a task group with both names", async () => {
		const { calls, router } = await renderDialog();
		const user = userEvent.setup();

		await user.click(screen.getByRole("combobox", { name: "Nodes or node groups" }));
		await user.click(await screen.findByRole("option", { name: /worker-01/ }));
		await user.click(await screen.findByRole("option", { name: /worker-02/ }));
		await user.keyboard("{Escape}");
		await user.type(screen.getByRole("textbox", { name: "Shell command" }), "uptime");
		await user.click(screen.getByRole("button", { name: /^Run$/ }));

		await waitFor(() => expect(created(calls, "/api/task-groups")).toBeDefined());
		expect(created(calls, "/api/task-groups")?.body).toMatchObject({ targets: ["worker-01", "worker-02"] });
		await waitFor(() => expect(router.state.location.pathname).toBe("/task-groups/group-1"));
	});

	test("all nodes disables the picker and sends _all alone", async () => {
		const { calls, router } = await renderDialog();
		const user = userEvent.setup();

		// A picked node stays visible but is ignored once "all" is on.
		await pickTarget(user, /worker-01/);
		await user.keyboard("{Escape}");
		await user.click(screen.getByRole("checkbox", { name: "All nodes I can access" }));
		expect(screen.getByRole("combobox", { name: "Nodes or node groups" })).toBeDisabled();
		await user.type(screen.getByRole("textbox", { name: "Shell command" }), "uptime");
		await user.click(screen.getByRole("button", { name: /^Run$/ }));

		await waitFor(() => expect(created(calls, "/api/task-groups")).toBeDefined());
		expect(created(calls, "/api/task-groups")?.body).toMatchObject({ targets: ["_all"] });
		await waitFor(() => expect(router.state.location.pathname).toBe("/task-groups/group-1"));
	});

	test("no target shows an inline error and submits nothing", async () => {
		const { calls, router } = await renderDialog();
		const user = userEvent.setup();

		await user.type(screen.getByRole("textbox", { name: "Shell command" }), "uptime");
		await user.click(screen.getByRole("button", { name: /^Run$/ }));

		expect(await screen.findByText("Choose at least one target.")).toBeInTheDocument();
		expect(calls.some((call) => call.method === "POST")).toBe(false);
		expect(router.state.location.pathname).toBe("/");
	});
});
