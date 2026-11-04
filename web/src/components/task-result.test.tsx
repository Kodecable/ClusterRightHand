import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { TaskView } from "@/lib/api/types";
import { renderWithRouter } from "@/test/render";
import { TaskOutcomeText, TaskResult, TaskSummary } from "./task-result";

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
		result: null,
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

	test("a revoked access error is explained in words, not as a code", async () => {
		const revoked = baseTask({
			state: "failed",
			exitCode: null,
			errorCode: "node_access_revoked",
			errorMessage: "access to the node was revoked before the task was dispatched",
		});
		await renderWithRouter(<TaskResult task={revoked} />);
		expect(screen.getByText("Access to the node was revoked before the task was dispatched.")).toBeInTheDocument();
		expect(screen.queryByText(/node_access_revoked/)).not.toBeInTheDocument();
	});

	test("the outcome line of a revoked access task is readable too", async () => {
		await renderWithRouter(
			<TaskOutcomeText
				task={baseTask({
					state: "failed",
					exitCode: null,
					errorCode: "node_access_revoked",
					errorMessage: "access to the node was revoked before the task was dispatched",
				})}
			/>,
		);
		expect(screen.getByText("Access to the node was revoked before the task was dispatched.")).toBeInTheDocument();
		expect(screen.queryByText(/node_access_revoked/)).not.toBeInTheDocument();
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

	test("head output mode shows the head a file operation kept", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({
					kind: "file.read",
					outputMode: "head",
					stdoutBytes: 120,
					stderrBytes: 0,
					stdoutHead: "one\ntwo\n",
					stdoutTail: "",
				})}
			/>,
		);
		expect(screen.getByLabelText("output")).toHaveTextContent("one two");
	});

	test("head output mode shows the notice crhs kept", async () => {
		const notice = "crh: privileged was ignored: SSH nodes run tasks as the SSH user\n";
		await renderWithRouter(
			<TaskResult
				task={baseTask({
					kind: "file.read",
					outputMode: "head",
					stdoutBytes: 8,
					stderrBytes: notice.length,
					stdoutHead: "one\ntwo\n",
					stdoutTail: "",
					stderrHead: notice,
				})}
			/>,
		);
		expect(screen.getByTestId("task-notice")).toHaveTextContent("privileged was ignored");
		// The notice is not part of the page the node kept.
		expect(screen.getByLabelText("output")).toHaveTextContent("one two");
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

	test("status output mode shows the notice crhs kept", async () => {
		const notice = "crh: privileged was ignored: SSH nodes run tasks as the SSH user\n";
		await renderWithRouter(
			<TaskResult
				task={baseTask({ outputMode: "status", outputFile: null, stderrBytes: notice.length, stderrHead: notice })}
			/>,
		);
		expect(screen.getByTestId("task-notice")).toHaveTextContent("privileged was ignored");
	});

	test("a file.read result shows its line range and the end of the file", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({
					kind: "file.read",
					result: { kind: "file.read", from: 10, to: 20, eof: true, total: 20, tooLong: false },
				})}
			/>,
		);
		const result = screen.getByTestId("task-result-file-read");
		expect(result).toHaveTextContent("Lines 10–20");
		expect(result).toHaveTextContent("end of file");
		expect(result).toHaveTextContent("20 lines in all");
	});

	test("a file.read page that is not the end of the file says more lines follow", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({
					kind: "file.read",
					result: { kind: "file.read", from: 1, to: 2000, eof: false, total: null, tooLong: false },
				})}
			/>,
		);
		const result = screen.getByTestId("task-result-file-read");
		expect(result).toHaveTextContent("Lines 1–2000");
		expect(result).toHaveTextContent("more lines follow");
		expect(result).not.toHaveTextContent("end of file");
	});

	test("a file.read result reports an empty page", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({
					kind: "file.read",
					result: { kind: "file.read", from: 0, to: 0, eof: true, total: 0, tooLong: false },
				})}
			/>,
		);
		expect(screen.getByTestId("task-result-file-read")).toHaveTextContent("Empty file.");
	});

	test("a file.read result reports a line too long to show", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({
					kind: "file.read",
					result: { kind: "file.read", from: 0, to: 0, eof: false, total: null, tooLong: true },
				})}
			/>,
		);
		expect(screen.getByTestId("task-result-file-read")).toHaveTextContent("longer than the 50 KB a page keeps");
	});

	test("a file.stat result shows the file's metadata", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({
					kind: "file.stat",
					result: {
						kind: "file.stat",
						path: "/etc/hosts",
						type: "file",
						size: 120,
						mode: "0644",
						uid: 1000,
						gid: 1000,
						owner: "alice",
						group: "users",
						mtime: "2026-01-01T00:00:00Z",
						linkTarget: null,
					},
				})}
			/>,
		);
		const result = screen.getByTestId("task-result-file-stat");
		expect(result).toHaveTextContent("/etc/hosts");
		expect(result).toHaveTextContent("120 bytes");
		expect(result).toHaveTextContent("alice (1000)");
		expect(result).not.toHaveTextContent("Link target");
	});

	test("a file.list result shows the entries and a truncation note", async () => {
		await renderWithRouter(
			<TaskResult
				task={baseTask({
					kind: "file.list",
					result: {
						kind: "file.list",
						truncated: true,
						entries: [
							{ name: "a.txt", type: "file", size: 3, mode: "0644", mtime: "2026-01-01T00:00:00Z" },
							{ name: "sub", type: "dir", size: 0, mode: "0755", mtime: "2026-01-01T00:00:00Z" },
						],
					},
				})}
			/>,
		);
		const result = screen.getByTestId("task-result-file-list");
		expect(result).toHaveTextContent("a.txt");
		expect(result).toHaveTextContent("sub");
		expect(result).toHaveTextContent("truncated");
	});

	test("a file.write result shows what it wrote", async () => {
		await renderWithRouter(
			<TaskResult task={baseTask({ kind: "file.write", result: { kind: "file.write", bytes: 7, created: true } })} />,
		);
		expect(screen.getByLabelText("task result")).toHaveTextContent("Wrote 7 bytes");
		expect(screen.getByLabelText("task result")).toHaveTextContent("a new file");
	});

	test("a file.edit result shows how many occurrences it replaced", async () => {
		await renderWithRouter(
			<TaskResult task={baseTask({ kind: "file.edit", result: { kind: "file.edit", replacements: 2 } })} />,
		);
		expect(screen.getByLabelText("task result")).toHaveTextContent("Replaced 2 occurrences");
	});

	test("status output mode shows no notice when crhs kept none", async () => {
		await renderWithRouter(<TaskResult task={baseTask({ outputMode: "status", outputFile: null })} />);
		expect(screen.queryByTestId("task-notice")).not.toBeInTheDocument();
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
