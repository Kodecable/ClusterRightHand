import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { UploadQueue } from "@/hooks/use-upload-queue";
import { renderWithI18n } from "@/test/render";
import { UploadProgressDialog } from "./upload-progress-dialog";

function queue(overrides: Partial<UploadQueue> = {}): UploadQueue {
	return {
		entries: [],
		done: 0,
		failures: [],
		totalFiles: 0,
		totalBytes: 0,
		loadedBytes: 0,
		speed: 0,
		eta: undefined,
		running: false,
		start: () => {},
		cancel: () => {},
		clear: () => {},
		...overrides,
	};
}

describe("UploadProgressDialog", () => {
	test("shows the overall progress, the size and the speed while running", () => {
		renderWithI18n(
			<UploadProgressDialog
				open
				onOpenChange={() => {}}
				queue={queue({
					done: 1,
					totalFiles: 2,
					totalBytes: 20,
					loadedBytes: 10,
					speed: 1024,
					eta: 10,
					running: true,
				})}
			/>,
		);
		expect(screen.getByRole("dialog", { name: "Uploading files" })).toBeVisible();
		expect(screen.getByTestId("upload-progress")).toBeVisible();
		expect(screen.getByText("1 / 2")).toBeVisible();
		expect(screen.getByText("20 B")).toBeVisible();
		expect(screen.getByText("1 KiB/s")).toBeVisible();
		expect(screen.getByText("10s")).toBeVisible();
	});

	test("lists every failed file with the server's reason", () => {
		renderWithI18n(
			<UploadProgressDialog
				open
				onOpenChange={() => {}}
				queue={queue({
					totalFiles: 2,
					totalBytes: 20,
					loadedBytes: 20,
					failures: [
						{
							id: 1,
							file: new File([], "big.bin"),
							error: "the file is larger than the library's one-file size limit",
						},
						{ id: 2, file: new File([], "other.bin"), error: "the library is full" },
					],
				})}
			/>,
		);
		const failures = screen.getByTestId("upload-failures");
		expect(within(failures).getByText("Failed files")).toBeVisible();
		expect(within(failures).getByText("big.bin")).toBeVisible();
		expect(within(failures).getByText("the file is larger than the library's one-file size limit")).toBeVisible();
		expect(within(failures).getByText("other.bin")).toBeVisible();
		expect(within(failures).getByText("the library is full")).toBeVisible();
	});

	test("cancels while running and closes when finished", async () => {
		const cancel = vi.fn();
		const onOpenChange = vi.fn();
		const { rerender } = renderWithI18n(
			<UploadProgressDialog
				open
				onOpenChange={onOpenChange}
				queue={queue({ totalFiles: 1, totalBytes: 4, running: true, cancel })}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(cancel).toHaveBeenCalledOnce();
		expect(onOpenChange).not.toHaveBeenCalled();

		rerender(
			<UploadProgressDialog
				open
				onOpenChange={onOpenChange}
				queue={queue({ totalFiles: 1, totalBytes: 4, loadedBytes: 4, done: 1 })}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
