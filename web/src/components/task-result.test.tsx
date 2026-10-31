import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { TaskView } from "@/lib/api/types";
import { renderWithRouter } from "@/test/render";
import { TaskResult, TaskSummary } from "./task-result";

const baseTask = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: "systemctl restart nginx",
		operation: { method: "exec", target: "systemctl restart nginx" },
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: null,
		state: "exited",
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		errorCode: null,
		errorMessage: null,
		stdoutBytes: 12,
		stderrBytes: 0,
		stdoutHead: "hello world\n",
		stdoutTail: "",
		stderrHead: "",
		stderrTail: "",
		outputFile: null,
		outputMode: "full",
		privileged: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:01.000Z",
		...overrides,
	}) as TaskView;

describe("TaskResult", () => {
	test("a clean exit shows the state, exit code and stdout", async () => {
		await renderWithRouter(<TaskResult task={baseTask()} />);
		expect(screen.getByText("Exited")).toBeInTheDocument();
		expect(screen.getByText("Exit code")).toBeInTheDocument();
		expect(screen.getByText("0")).toBeInTheDocument();
		expect(screen.getByLabelText("stdout")).toHaveTextContent("hello world");
	});

	test("a non-zero exit is the command's own failure", async () => {
		await renderWithRouter(<TaskResult task={baseTask({ exitCode: 2 })} />);
		expect(screen.getByText("Exited (2)")).toBeInTheDocument();
	});

	test("a failing task shows the platform error", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({ state: "failed", exitCode: null, errorCode: "node_offline", errorMessage: "gone" })}
			/>,
		);
		expect(screen.getByText("Failed")).toBeInTheDocument();
		expect(screen.getByText(/node_offline/)).toBeInTheDocument();
	});

	test("output head and tail with a gap show the omitted marker", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({ stdoutBytes: 1000, stdoutHead: "start\n", stdoutTail: "end\n", stderrHead: "err\n" })}
			/>,
		);
		const stdout = screen.getByLabelText("stdout");
		expect(stdout).toHaveTextContent("start");
		expect(stdout).toHaveTextContent("end");
		expect(stdout).toHaveTextContent("bytes omitted");
		expect(screen.getByLabelText("stderr")).toHaveTextContent("err");
	});

	test("waiting for approval links to the approval page", async () => {
		await renderWithRouter(<TaskResult task={baseTask({ state: "awaiting_approval" })} />);
		expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Open approval page" })).toHaveAttribute("href", "/approvals/tasks/task-1");
	});

	test("waiting for an owner's authorization names the attempt", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({
					state: "awaiting_authorization",
					authorization: {
						plan: { paths: [{ path: "user", entries: [{ name: "laptop", role: "user" }] }] },
						tried: [],
						dispatchedPath: null,
						payloadId: "p1",
						attempt: 3,
						trustDigest: null,
						lastRejection: null,
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				})}
			/>,
		);
		expect(screen.getByText("Waiting for the owner's authorization. (attempt 3)")).toBeInTheDocument();
		expect(screen.getByText(/laptop \(user\)/)).toBeInTheDocument();
	});

	test("text output mode shows the combined tail", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({
					outputMode: "text",
					stdoutBytes: 40,
					stderrBytes: 2,
					stdoutTail: "tail text\n",
					stdoutHead: "",
				})}
			/>,
		);
		expect(screen.getByLabelText("output")).toHaveTextContent("tail text");
	});

	test("status output mode points at the node's output file", async () => {
		await renderWithRouter(
			<TaskResult task={baseTask({ outputMode: "status", outputFile: "/var/lib/crha/output/t.log" })} />,
		);
		expect(screen.getByText(/Status only/)).toBeInTheDocument();
		expect(screen.getAllByText("/var/lib/crha/output/t.log").length).toBeGreaterThan(0);
	});

	test("status output mode explains an SSH node without a file", async () => {
		await renderWithRouter(<TaskResult task={baseTask({ outputMode: "status", outputFile: null })} />);
		expect(screen.getByText(/SSH nodes keep no output/)).toBeInTheDocument();
	});
});

describe("TaskSummary", () => {
	test("is one compact row linking to the task", async () => {
		await renderWithRouter(<TaskSummary task={baseTask()} nodeName="worker-01" />, "en");
		expect(screen.getByTestId("task-summary")).toHaveAttribute("href", "/tasks/task-1");
		expect(screen.getByText("worker-01")).toBeInTheDocument();
		expect(screen.getByText("Exit code 0")).toBeInTheDocument();
	});
});
