import type { JobView, TodoItem } from "@crh/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { BackgroundBar } from "./background-bar";

afterEach(() => {
	vi.unstubAllGlobals();
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

const job = (overrides: Partial<JobView> = {}): JobView => ({
	id: "exec-1",
	kind: "exec",
	state: "running",
	wait: null,
	outcome: null,
	action: { type: "exec", command: "echo hi" },
	sessionId: "s1",
	resource: { type: "task", id: "t1" },
	createdAt: "2026-01-01T00:00:00.000Z",
	settledAt: null,
	...overrides,
});

const RUNNING_TASK = job();
const WAITING_CALL = job({
	id: "call-1",
	kind: "call",
	state: "waiting",
	wait: "approval",
	action: { type: "extension_tool", extension: "github", tool: "create_issue" },
	resource: { type: "external_call", id: "c1" },
});
const SETTLED_TASK = job({
	id: "exec-2",
	state: "settled",
	outcome: { kind: "succeeded", failed: false },
	action: { type: "exec", command: "echo settled" },
	resource: { type: "task", id: "t2" },
	settledAt: "2026-01-01T00:01:00.000Z",
});

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Answers the bar's job list per session; every other request is empty. */
function mockJobs(bySession: Record<string, JobView[]>): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://localhost");
		if (url.pathname === "/api/jobs" && (init?.method ?? "GET") === "GET") {
			const session = url.searchParams.get("session") ?? "";
			return json({ items: bySession[session] ?? [], nextCursor: null });
		}
		if (url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/cancel")) {
			const id = url.pathname.split("/")[3] ?? "";
			return json({ cancelled: true, job: job({ id, state: "settled", settledAt: "2026-01-01T00:02:00.000Z" }) });
		}
		return json({});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function openBar(): Promise<HTMLElement> {
	const trigger = await screen.findByTestId("background-bar");
	fireEvent.click(trigger);
	return await screen.findByTestId("background-tree");
}

describe("BackgroundBar", () => {
	test("shows only active jobs, with the running and waiting counts", async () => {
		mockJobs({ s1: [RUNNING_TASK, WAITING_CALL, SETTLED_TASK] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={null} />);
		const trigger = await screen.findByTestId("background-bar");
		expect(trigger).toHaveTextContent("2 background jobs");
		expect(trigger).toHaveTextContent("1 running");
		expect(trigger).toHaveTextContent("1 waiting");

		const tree = await openBar();
		expect(within(tree).getByRole("link", { name: "echo hi" })).toHaveAttribute("href", "/tasks/t1");
		expect(within(tree).getByText("github/create_issue")).toBeInTheDocument();
		expect(within(tree).queryByText("echo settled")).not.toBeInTheDocument();
	});

	test("a row with a resource page links to it and has no Stop; an extension call has Stop for the owner", async () => {
		const fetchMock = mockJobs({ s1: [RUNNING_TASK, WAITING_CALL] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={null} />);
		const tree = await openBar();
		const taskLink = within(tree).getByRole("link", { name: "echo hi" });
		expect(taskLink).toHaveAttribute("href", "/tasks/t1");
		const taskRow = taskLink.closest("li");
		expect(taskRow).not.toBeNull();
		expect(within(taskRow as HTMLElement).queryByTestId("background-job-stop")).not.toBeInTheDocument();

		const callAction = within(tree).getByText("github/create_issue");
		const callRow = callAction.closest("li");
		expect(callRow).not.toBeNull();
		expect(within(callRow as HTMLElement).queryByRole("link")).not.toBeInTheDocument();
		const stop = within(callRow as HTMLElement).getByTestId("background-job-stop");
		fireEvent.click(stop);
		await waitFor(() =>
			expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/jobs/call-1/cancel"))).toBe(true),
		);
	});

	test("a share viewer sees the rows without Stop", async () => {
		mockJobs({ s1: [WAITING_CALL] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner={false} revision={0} isRoot todos={null} />);
		const tree = await openBar();
		expect(within(tree).getByText("github/create_issue")).toBeInTheDocument();
		expect(within(tree).queryByTestId("background-job-stop")).not.toBeInTheDocument();
	});

	test("a subagent job expands to its own active jobs, loaded when opened", async () => {
		const subagent = job({
			id: "subagent-1",
			kind: "subagent",
			action: { type: "subagent", task: "fix the failing test" },
			resource: { type: "session", id: "child-1" },
		});
		const nested = job({
			id: "exec-9",
			action: { type: "exec", command: "nested work" },
			resource: { type: "task", id: "t9" },
		});
		const fetchMock = mockJobs({ s1: [subagent], "child-1": [nested] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={null} />);
		const tree = await openBar();
		expect(within(tree).getByRole("link", { name: "fix the failing test" })).toHaveAttribute(
			"href",
			"/sessions/child-1",
		);
		// The nested level is not loaded until the row expands.
		expect(fetchMock.mock.calls.some(([url]) => String(url).includes("session=child-1"))).toBe(false);
		fireEvent.click(within(tree).getByTestId("background-job-expand"));
		expect(await within(tree).findByRole("link", { name: "nested work" })).toHaveAttribute("href", "/tasks/t9");
		expect(fetchMock.mock.calls.some(([url]) => String(url).includes("session=child-1"))).toBe(true);
	});

	test("a long action truncates inside the row and the tree cannot scroll sideways", async () => {
		const action = `systemctl restart ${"a-very-long-service-name-".repeat(12)}`;
		mockJobs({ s1: [job({ action: { type: "exec", command: action } })] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={null} />);
		const tree = await openBar();
		const popover = screen.getByTestId("background-popover");
		// jsdom does not lay out, so the constraints that keep the row inside the popover are asserted by class.
		expect(popover).toHaveClass("w-96", "max-w-[calc(100vw-2rem)]", "overflow-x-hidden");
		expect(tree).toHaveClass("min-w-0", "overflow-x-hidden");
		expect(tree.querySelector("ul")).toHaveClass("grid-cols-[minmax(0,1fr)]");
		const link = within(tree).getByTestId("background-job-link");
		expect(link).toHaveClass("min-w-0", "flex-1", "truncate");
		expect(link).toHaveAttribute("title", action);
		const state = within(tree).getByTestId("background-job-state");
		expect(state).toHaveClass("min-w-0", "max-w-[50%]");
		expect(state.firstElementChild).toHaveClass("truncate");
		// The duration keeps its width while the state name is the part that gives way.
		expect(state.lastElementChild).toHaveClass("shrink-0", "tabular-nums");
		expect(screen.getByTestId("background-bar").querySelector("span.inline-flex")).toHaveClass(
			"min-w-0",
			"flex-1",
			"overflow-hidden",
		);
	});

	test("the trigger opens the bottom sheet on a mobile width", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
		mockJobs({ s1: [RUNNING_TASK] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={null} />);
		// Wait until the jobs loaded and the mobile layout replaced the desktop shell.
		await waitFor(() => {
			expect(screen.getByTestId("background-bar")).toBeInTheDocument();
			expect(screen.queryByTestId("background-bar-shell")).not.toBeInTheDocument();
		});
		fireEvent.click(screen.getByTestId("background-bar"));
		const sheet = await screen.findByTestId("background-sheet");
		expect(within(sheet).getByText("Background jobs")).toBeInTheDocument();
		expect(within(sheet).getByRole("link", { name: "echo hi" })).toHaveAttribute("href", "/tasks/t1");
	});
});

const TODOS: TodoItem[] = [
	{ content: "Back up /etc/nginx on web-1..3", status: "completed" },
	{ content: "Roll out the new config to web-1..3", status: "in_progress" },
	{ content: "Check the health endpoint on every node", status: "in_progress" },
	{ content: "Verify that every node serves 200", status: "pending" },
	{ content: "Write the rollback note", status: "completed" },
];

describe("BackgroundBar todo side", () => {
	test("with no active jobs the left side reads 0 background jobs and opens nothing", async () => {
		mockJobs({});
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={null} />);
		const bar = await screen.findByTestId("background-bar");
		expect(bar).toHaveTextContent("0 background jobs");
		expect(bar).toHaveAttribute("data-empty", "true");
		fireEvent.click(bar);
		expect(screen.queryByTestId("background-popover")).not.toBeInTheDocument();
		expect(screen.queryByTestId("background-sheet")).not.toBeInTheDocument();
	});

	test("shows nothing on the right without a list", async () => {
		mockJobs({ s1: [RUNNING_TASK] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={null} />);
		await screen.findByTestId("background-bar");
		expect(screen.queryByTestId("todo-bar")).not.toBeInTheDocument();
	});

	test("an empty list counts as no list", async () => {
		mockJobs({ s1: [RUNNING_TASK] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={[]} />);
		await screen.findByTestId("background-bar");
		expect(screen.queryByTestId("todo-bar")).not.toBeInTheDocument();
	});

	test("a subagent session shows the jobs side only", async () => {
		mockJobs({ s1: [RUNNING_TASK] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot={false} todos={TODOS} />);
		expect(await screen.findByTestId("background-bar")).toHaveTextContent("1 background job");
		expect(screen.queryByTestId("todo-bar")).not.toBeInTheDocument();
	});

	test("summarizes progress with the first in-progress item and counts the rest", async () => {
		mockJobs({ s1: [RUNNING_TASK] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={TODOS} />);
		const summary = await screen.findByTestId("todo-bar-summary");
		expect(summary).toHaveTextContent("2/5 · Roll out the new config to web-1..3");
		expect(summary).toHaveAttribute("title", "2/5 · Roll out the new config to web-1..3");
		expect(screen.getByTestId("todo-bar-more")).toHaveTextContent("+1");
		expect(summary).toHaveClass("truncate");
	});

	test("opens every item with its status icon in the desktop popover", async () => {
		mockJobs({ s1: [RUNNING_TASK] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={TODOS} />);
		fireEvent.click(await screen.findByTestId("todo-bar"));
		const popover = await screen.findByTestId("todo-popover");
		expect(popover).toHaveClass("w-96", "max-w-[calc(100vw-2rem)]", "overflow-x-hidden");
		const list = within(popover).getByTestId("todo-list");
		expect(within(list).getAllByRole("listitem")).toHaveLength(5);
		expect(within(list).getAllByRole("img", { name: "Completed" })).toHaveLength(2);
		expect(within(list).getAllByRole("img", { name: "In progress" })).toHaveLength(2);
		expect(within(list).getAllByRole("img", { name: "Pending" })).toHaveLength(1);
		expect(within(list).getByText("Verify that every node serves 200")).toHaveAttribute(
			"title",
			"Verify that every node serves 200",
		);
	});

	test("opens as a bottom sheet on a mobile width", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
		mockJobs({ s1: [RUNNING_TASK] });
		await renderWithRouter(<BackgroundBar sessionId="s1" isOwner revision={0} isRoot todos={TODOS} />);
		await waitFor(() => expect(screen.queryByTestId("background-bar-shell")).not.toBeInTheDocument());
		fireEvent.click(await screen.findByTestId("todo-bar"));
		const sheet = await screen.findByTestId("todo-sheet");
		expect(within(sheet).getByText("Todo list")).toBeInTheDocument();
		expect(within(sheet).getAllByRole("listitem")).toHaveLength(5);
	});
});
