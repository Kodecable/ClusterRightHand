import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ToolCard } from "./tool-card";
import type { TranscriptItem } from "./transcript-items";
import { TranscriptStreams } from "./transcript-streams";

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
