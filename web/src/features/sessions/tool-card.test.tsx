import type { JobView } from "@crh/api";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ToolCard } from "./tool-card";
import type { TranscriptItem } from "./transcript-items";

afterEach(() => {
	vi.unstubAllGlobals();
});

const ITEM: Extract<TranscriptItem, { kind: "tool" }> = {
	kind: "tool",
	key: "t1",
	callId: "call-1",
	name: "view_image",
	args: { library: "user:alice", path: "screens/pic.png" },
	status: "done",
	output: "",
	details: undefined,
	result: {
		text: "[view_image pic.png, image/png, 800x600, 1200 bytes]",
		isError: false,
		details: {
			image: {
				sha256: "ab".repeat(32),
				mime: "image/png",
				width: 800,
				height: 600,
				bytes: 1200,
				source: { library: "user:alice", path: "screens/pic.png" },
			},
		},
		blocks: ["[view_image pic.png]"],
	},
};

describe("view_image tool card", () => {
	test("shows the source, dimensions, size and SHA-256 without the image", async () => {
		await renderWithRouter(<ToolCard item={ITEM} sessionActive={false} />);
		const summary = screen.getByTestId("view-image-summary");
		expect(summary).toHaveTextContent("user:alice");
		expect(summary).toHaveTextContent("screens/pic.png");
		expect(summary).toHaveTextContent("800×600");
		expect(summary).toHaveTextContent("1.2 KiB");
		expect(summary).toHaveTextContent("abababababab");
		// The library source links to the library page at the file's directory.
		const link = screen.getByRole("link", { name: "user:alice" });
		expect(link).toHaveAttribute("href", "/library/user%3Aalice?path=screens");
		expect(document.querySelector("img")).toBeNull();
	});

	test("a node source has no link", async () => {
		await renderWithRouter(
			<ToolCard
				item={{
					...ITEM,
					result: {
						...ITEM.result,
						text: ITEM.result?.text ?? "",
						isError: false,
						details: {
							image: {
								sha256: "cd".repeat(32),
								mime: "image/png",
								width: 4,
								height: 3,
								bytes: 10,
								source: { node: "web-1", path: "/srv/a.png" },
							},
						},
					},
				}}
				sessionActive={false}
			/>,
		);
		const summary = screen.getByTestId("view-image-summary");
		expect(summary).toHaveTextContent("web-1");
		expect(summary).not.toHaveTextContent("user:alice");
		expect(screen.queryByRole("link", { name: "web-1" })).not.toBeInTheDocument();
	});
});

const JOB: JobView = {
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
};

/** Answers `GET /jobs/:id`; `settled` flips the job to its finished state. */
function mockJobPoll(): { fetchMock: ReturnType<typeof vi.fn>; settle: () => void } {
	let settled = false;
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://localhost");
		const body =
			url.pathname === "/api/jobs/exec-1"
				? {
						job: settled
							? {
									...JOB,
									state: "settled",
									outcome: { kind: "succeeded", failed: false },
									settledAt: "2026-01-01T00:01:00.000Z",
								}
							: JOB,
					}
				: {};
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, settle: () => (settled = true) };
}

describe("a job-backed tool card", () => {
	test("shows the background state and follows the job until it settles", async () => {
		const { fetchMock, settle } = mockJobPoll();
		const item: Extract<TranscriptItem, { kind: "tool" }> = {
			kind: "tool",
			key: "a1/0",
			callId: "call-1",
			name: "exec",
			args: { cmd: "echo hi" },
			status: "done",
			output: "",
			details: { job_id: "exec-1", task_id: "t1" },
			result: {
				text: "[web-1, still running, job exec-1]",
				isError: false,
				details: { job_id: "exec-1", task_id: "t1" },
			},
		};
		await renderWithRouter(<ToolCard item={item} sessionActive jobPollMs={20} />);
		expect(await screen.findByTestId("tool-job-state")).toHaveTextContent("Background · Running");
		expect(screen.getByTestId("tool-card")).toHaveAttribute("data-tool-status", "running");
		expect(fetchMock).toHaveBeenCalled();

		settle();
		await waitFor(() => expect(screen.queryByTestId("tool-job-state")).not.toBeInTheDocument(), { timeout: 3_000 });
		expect(screen.getByTestId("tool-status-icon")).toHaveAccessibleName("Done");
		expect(screen.getByTestId("tool-card")).toHaveAttribute("data-tool-status", "done");
		// The dialog links the job's resource page.
		fireEvent.click(screen.getByTestId("tool-toggle"));
		expect(await screen.findByRole("link", { name: "Task details" })).toHaveAttribute("href", "/tasks/t1");

		// A settled job is read once more and stops: no further poll lands in the next window.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const calls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/jobs/exec-1")).length;
		const stopped = calls();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(calls()).toBe(stopped);
	});
});
