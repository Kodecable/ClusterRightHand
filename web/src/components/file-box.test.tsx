import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { FileBox } from "./file-box";

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubObjectUrls(src = "blob:file"): void {
	Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => src), configurable: true });
	Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
}

describe("FileBox", () => {
	test("links the name and size to the download in a narrow box and keeps the path as the tooltip", () => {
		renderWithI18n(
			<FileBox name="report.txt" bytes={1234} path="docs/report.txt" download="/files/report" testId="file-box" />,
		);
		const box = screen.getByTestId("file-box");
		expect(box).toHaveClass("w-full", "max-w-xs");
		expect(box).toHaveTextContent("report.txt");
		expect(box).toHaveTextContent("1.2 KiB");
		expect(screen.getByText("report.txt")).toHaveClass("truncate");
		const link = screen.getByTestId("file-box-download");
		expect(link).toHaveAttribute("href", "/files/report");
		expect(link).toHaveAttribute("title", "docs/report.txt");
		expect(link).toHaveAccessibleName("Download report.txt");
		// A text file has no preview button.
		expect(screen.queryByTestId("file-box-preview")).not.toBeInTheDocument();
	});

	test("centres the file icon against the name and source block", () => {
		const { rerender } = renderWithI18n(
			<FileBox
				name="report.txt"
				bytes={12}
				source="web-1"
				path="/srv/report.txt"
				download="/files/report"
				testId="delivery-box"
			/>,
		);
		const icon = screen.getByTestId("delivery-box").querySelector(".lucide-file");
		expect(icon).not.toBeNull();
		expect(icon).not.toHaveClass("mt-0.5");
		expect(icon?.parentElement).toHaveClass("items-center");
		expect(icon?.parentElement).not.toHaveClass("items-start");

		// The inactive variant renders the same body, so its icon is centred too.
		rerender(
			<FileBox
				name="report.txt"
				bytes={12}
				source="web-1"
				path="/srv/report.txt"
				reason="You don't have access to this library."
				testId="delivery-box"
			/>,
		);
		expect(screen.getByTestId("delivery-box").querySelector(".lucide-file")?.parentElement).toHaveClass("items-center");
	});

	test("shows a delivered file's source under its name", () => {
		renderWithI18n(
			<FileBox
				name="report.txt"
				bytes={12}
				source="web-1"
				path="/srv/report.txt"
				download="/files/report"
				testId="delivery-box"
				downloadTestId="delivery-download"
			/>,
		);
		expect(screen.getByTestId("delivery-box")).toHaveTextContent("web-1");
		expect(screen.getByTestId("delivery-download")).toHaveAttribute("title", "/srv/report.txt");
	});

	test("offers a preview for an image, from its media type or its name", () => {
		renderWithI18n(
			<FileBox
				name="notes.txt"
				bytes={10}
				mime="image/png"
				path="screens/notes.txt"
				download="/files/notes"
				preview="/files/notes?preview=1"
				testId="file-box"
			/>,
		);
		expect(screen.getByTestId("file-box-preview")).toHaveAccessibleName("Preview notes.txt");
	});

	test("offers a preview from the name when the media type is unknown", () => {
		renderWithI18n(
			<FileBox
				name="pic.webp"
				path="screens/pic.webp"
				download="/files/pic"
				preview="/files/pic?preview=1"
				testId="file-box"
			/>,
		);
		expect(screen.getByTestId("file-box-preview")).toBeInTheDocument();
	});

	test("offers no preview for another type or an image past 20 MiB", () => {
		const { rerender } = renderWithI18n(
			<FileBox
				name="notes.txt"
				path="notes.txt"
				download="/files/notes"
				preview="/files/notes?preview=1"
				testId="file-box"
			/>,
		);
		expect(screen.queryByTestId("file-box-preview")).not.toBeInTheDocument();
		rerender(
			<FileBox
				name="huge.png"
				bytes={20 * 1024 * 1024 + 1}
				path="screens/huge.png"
				download="/files/huge"
				preview="/files/huge?preview=1"
				testId="file-box"
			/>,
		);
		expect(screen.queryByTestId("file-box-preview")).not.toBeInTheDocument();
	});

	test("an inactive box shows the reason instead of a download", () => {
		renderWithI18n(
			<FileBox
				name="report.txt"
				path="docs/report.txt"
				reason="You don't have access to this library."
				testId="file-box"
			/>,
		);
		expect(screen.getByTestId("file-box-inactive")).toHaveTextContent("report.txt");
		expect(screen.getByTestId("file-box-reason")).toHaveTextContent("You don't have access to this library.");
		expect(screen.queryByTestId("file-box-download")).not.toBeInTheDocument();
		expect(screen.queryByTestId("file-box-preview")).not.toBeInTheDocument();
	});

	test("opens the image preview from the preview URL", async () => {
		stubObjectUrls();
		const fetch = vi.fn(
			async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetch);
		renderWithI18n(
			<FileBox
				name="pic.png"
				bytes={10}
				path="screens/pic.png"
				download="/files/pic"
				preview="/files/pic?preview=1"
				testId="file-box"
			/>,
		);
		await userEvent.click(screen.getByTestId("file-box-preview"));
		expect(await screen.findByTestId("file-preview-image")).toHaveAttribute("src", "blob:file");
		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				"/files/pic?preview=1",
				expect.objectContaining({ credentials: "same-origin" }),
			),
		);
	});

	test("a failed preview shows the endpoint's error instead of an image", async () => {
		stubObjectUrls();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "this file cannot be previewed" }), {
						status: 415,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		renderWithI18n(
			<FileBox
				name="pic.png"
				path="screens/pic.png"
				download="/files/pic"
				preview="/files/pic?preview=1"
				testId="file-box"
			/>,
		);
		await userEvent.click(screen.getByTestId("file-box-preview"));
		expect(await screen.findByText("this file cannot be previewed")).toBeInTheDocument();
		expect(screen.queryByTestId("file-preview-image")).not.toBeInTheDocument();
	});
});
