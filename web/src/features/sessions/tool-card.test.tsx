import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import type { JsonObject } from "./session-events";
import { ToolCard } from "./tool-card";
import type { TranscriptItem } from "./transcript-items";
import { TranscriptStreams } from "./transcript-streams";

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
		await renderWithRouter(<ToolCard item={ITEM} streams={new TranscriptStreams()} sessionActive={false} />);
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
				streams={new TranscriptStreams()}
				sessionActive={false}
			/>,
		);
		const summary = screen.getByTestId("view-image-summary");
		expect(summary).toHaveTextContent("web-1");
		expect(summary).not.toHaveTextContent("user:alice");
		expect(screen.queryByRole("link", { name: "web-1" })).not.toBeInTheDocument();
	});
});

/** A `copy_file to_user: true` result with one delivery, as the server records it. */
function deliveryItem(delivery: JsonObject): Extract<TranscriptItem, { kind: "tool" }> {
	return {
		kind: "tool",
		key: "d1",
		callId: "call-delivery",
		name: "copy_file",
		args: { source: { library: "user:alice", path: "docs/report.txt" }, to_user: true },
		status: "done",
		output: "",
		details: undefined,
		result: {
			text: "[copy_file offered report.txt, 11 bytes, to the user for download]",
			isError: false,
			details: { delivery },
			blocks: ["[copy_file offered report.txt, 11 bytes, to the user for download]"],
		},
	};
}

describe("copy_file delivery card", () => {
	test("shows the name, library source and path with a download link resolved by id", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ libraries: [{ id: "lib-1", ref: "group:team-renamed" }] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		await renderWithRouter(
			<ToolCard
				item={deliveryItem({
					source: { library: "group:team", libraryId: "lib-1", path: "docs/report.txt" },
					name: "report.txt",
					bytes: 1234,
				})}
				streams={new TranscriptStreams()}
				sessionActive={false}
			/>,
		);
		const summary = screen.getByTestId("copy-delivery");
		expect(summary).toHaveTextContent("report.txt");
		expect(summary).toHaveTextContent("group:team");
		expect(summary).toHaveTextContent("docs/report.txt");
		expect(summary).toHaveTextContent("1.2 KiB");
		// The stored reference is history; the link follows the library id to its current reference.
		await waitFor(() =>
			expect(screen.getByTestId("copy-delivery-download")).toHaveAttribute(
				"href",
				"/api/libraries/group%3Ateam-renamed/file?path=docs%2Freport.txt",
			),
		);
	});

	test("a node source downloads through the node endpoint", async () => {
		await renderWithRouter(
			<ToolCard
				item={deliveryItem({
					source: { node: "web-1", nodeId: "node-1", path: "/srv/report.txt" },
					name: "report.txt",
				})}
				streams={new TranscriptStreams()}
				sessionActive={false}
			/>,
		);
		const summary = screen.getByTestId("copy-delivery");
		expect(summary).toHaveTextContent("web-1");
		expect(summary).toHaveTextContent("/srv/report.txt");
		expect(screen.getByTestId("copy-delivery-download")).toHaveAttribute(
			"href",
			"/api/nodes/node-1/file?path=%2Fsrv%2Freport.txt",
		);
	});
});
