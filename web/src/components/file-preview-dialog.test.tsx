import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { FilePreviewDialog } from "./file-preview-dialog";

beforeEach(() => {
	Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:preview"), configurable: true });
	Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

function imageLoader() {
	return vi.fn(async (_signal: AbortSignal) => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
}

describe("FilePreviewDialog", () => {
	test("loads the image and shows it as an object URL", async () => {
		const load = imageLoader();
		renderWithI18n(<FilePreviewDialog name="pic.png" load={load} onClose={() => {}} />);

		const image = await screen.findByTestId("file-preview-image");
		expect(image).toHaveAttribute("src", "blob:preview");
		expect(image).toHaveAccessibleName("pic.png");
		expect(load).toHaveBeenCalledWith(expect.any(AbortSignal));
		expect(screen.getByRole("dialog", { name: "pic.png" })).toBeInTheDocument();
	});

	test("closes with the close button and aborts the load", async () => {
		const load = imageLoader();
		const onClose = vi.fn();
		renderWithI18n(<FilePreviewDialog name="pic.png" load={load} onClose={onClose} />);
		await screen.findByTestId("file-preview-image");
		const signal = load.mock.calls[0]?.[0] as AbortSignal;

		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(signal.aborted).toBe(true));
	});

	test("closes with Escape and aborts the load", async () => {
		const load = imageLoader();
		const onClose = vi.fn();
		renderWithI18n(<FilePreviewDialog name="pic.png" load={load} onClose={onClose} />);
		await screen.findByTestId("file-preview-image");
		const signal = load.mock.calls[0]?.[0] as AbortSignal;

		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(signal.aborted).toBe(true));
	});

	test("renders a load failure instead of an image", async () => {
		const load = vi.fn(async () => {
			throw new Error("the preview endpoint failed");
		});
		renderWithI18n(<FilePreviewDialog name="pic.png" load={load} onClose={() => {}} />);

		expect(await screen.findByText("the preview endpoint failed")).toBeInTheDocument();
		expect(screen.queryByTestId("file-preview-image")).not.toBeInTheDocument();
	});
});
