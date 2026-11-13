import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { renderWithI18n } from "@/test/render";
import { FileManager, type FileManagerProps } from "./file-manager";
import { FilePickerDialog } from "./file-picker-dialog";
import type { FileEntry, FileSource, FileUploadOptions } from "./types";

const PNG: FileEntry = {
	path: "pic.png",
	name: "pic.png",
	kind: "file",
	size: 10,
	mediaType: "image/png",
	updatedAt: "2026-01-01T00:00:00.000Z",
};
const NOTES: FileEntry = {
	path: "notes.txt",
	name: "notes.txt",
	kind: "file",
	size: 5,
	mediaType: "text/plain",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeSource(overrides: Partial<FileSource> = {}): FileSource {
	return {
		async list(prefix) {
			if (prefix === "docs") {
				return { files: [{ ...NOTES, path: "docs/notes.txt", name: "notes.txt" }], directories: [] };
			}
			return { files: [PNG, NOTES], directories: ["docs"] };
		},
		stat: vi.fn(async (path: string) => {
			const entry = [PNG, NOTES].find((candidate) => candidate.path === path);
			if (!entry) throw new Error("not found");
			return entry;
		}),
		download: (path) => `/api/file?path=${encodeURIComponent(path)}`,
		upload: vi.fn(async (path: string, file: File, options) => {
			options.onProgress?.(file.size, file.size);
			return { path, name: file.name, kind: "file" as const, size: file.size, mediaType: "text/plain" };
		}),
		delete: vi.fn(async () => {}),
		rename: vi.fn(async (_from: string, to: string) => ({ ...NOTES, path: to, name: to })),
		preview: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
		...overrides,
	};
}

function renderManager(source: FileSource, props: Partial<FileManagerProps> = {}) {
	const onPathChange = vi.fn();
	renderWithI18n(
		<FileManager source={source} path="" onPathChange={onPathChange} rootLabel="Test library" {...props} />,
	);
	return { onPathChange };
}

beforeAll(() => {
	// jsdom has no object URLs; the preview dialog only needs a stable src.
	Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:preview"), configurable: true });
	Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("FileManager", () => {
	test("lists directories before files and browses with the breadcrumb", async () => {
		const source = makeSource();
		const { onPathChange } = renderManager(source);
		const table = await screen.findByRole("table", { name: "Files in Test library" });
		const rows = within(table).getAllByRole("row");
		expect(rows[1]).toHaveTextContent("docs");
		expect(rows[2]).toHaveTextContent("notes.txt");
		expect(rows[3]).toHaveTextContent("pic.png");

		await userEvent.click(screen.getByRole("button", { name: "docs" }));
		expect(onPathChange).toHaveBeenCalledWith("docs");
		// A directory's path has no preview, download or delete action.
		expect(screen.queryByRole("button", { name: "Delete docs" })).not.toBeInTheDocument();
	});

	test("previews a small image when its action is opened", async () => {
		const source = makeSource();
		renderManager(source);
		await screen.findByRole("table");
		await userEvent.click(screen.getByRole("button", { name: "Preview pic.png" }));

		const image = await screen.findByRole("img", { name: "pic.png" });
		expect(image).toHaveAttribute("src", "blob:preview");
		expect(source.stat).toHaveBeenCalledWith("pic.png");
		expect(source.preview).toHaveBeenCalledWith("pic.png");

		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	test("uploads several files through the progress dialog and reports the result", async () => {
		const source = makeSource();
		renderManager(source);
		await screen.findByRole("table");
		const input = screen.getByTestId("file-upload-input");
		fireEvent.change(input, {
			target: {
				files: [new File(["hello"], "hello.txt", { type: "text/plain" }), new File(["world"], "world.txt")],
			},
		});

		const dialog = await screen.findByRole("dialog", { name: "Uploading files" });
		await waitFor(() => expect(source.upload).toHaveBeenCalledTimes(2));
		expect(await within(dialog).findByText("2 / 2")).toBeVisible();
		expect(within(dialog).getByText("10 B")).toBeVisible();
		expect(within(dialog).queryByTestId("upload-failures")).not.toBeInTheDocument();
		expect(source.upload).toHaveBeenNthCalledWith(
			1,
			"hello.txt",
			expect.any(File),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		await userEvent.click(await within(dialog).findByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByTestId("upload-progress-dialog")).not.toBeInTheDocument());
	});

	test("skips a failed file and lists its error", async () => {
		const source = makeSource({
			upload: vi.fn(async (path: string, file: File) => {
				if (path === "big.bin") throw new ApiError(400, "the file is larger than the library's one-file size limit");
				return { path, name: file.name, kind: "file" as const, size: file.size, mediaType: "text/plain" };
			}),
		});
		renderManager(source);
		await screen.findByRole("table");
		fireEvent.change(screen.getByTestId("file-upload-input"), {
			target: { files: [new File(["x"], "big.bin"), new File(["ok"], "small.txt")] },
		});

		const dialog = await screen.findByRole("dialog", { name: "Uploading files" });
		expect(await within(dialog).findByText("Failed files")).toBeVisible();
		expect(within(dialog).getByText("big.bin")).toBeVisible();
		expect(within(dialog).getByText("the file is larger than the library's one-file size limit")).toBeVisible();
		expect(within(dialog).getByText("1 / 2")).toBeVisible();
		await waitFor(() => expect(source.upload).toHaveBeenCalledTimes(2));
		expect(await within(dialog).findByRole("button", { name: "Close" })).toBeVisible();
	});

	test("cancels the file in flight and the remaining uploads", async () => {
		const upload = vi.fn(
			(_path: string, _file: File, options: FileUploadOptions) =>
				new Promise<FileEntry>((_resolve, reject) => {
					options.onProgress?.(1, 10);
					options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}),
		);
		renderManager(makeSource({ upload }));
		await screen.findByRole("table");
		fireEvent.change(screen.getByTestId("file-upload-input"), {
			target: { files: [new File(["hello"], "hello.txt"), new File(["world"], "world.txt")] },
		});
		const dialog = await screen.findByRole("dialog", { name: "Uploading files" });
		await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));

		await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(await within(dialog).findByRole("button", { name: "Close" })).toBeVisible();
		expect(upload).toHaveBeenCalledTimes(1);
	});

	test("renames with the pencil line icon", async () => {
		renderManager(makeSource());
		await screen.findByRole("table");
		const button = screen.getByRole("button", { name: "Move or rename notes.txt" });
		expect(button.querySelector("svg")).toHaveClass("lucide-pencil-line");
	});

	test("hides the size and updated columns on a narrow screen", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
		renderManager(makeSource());
		await screen.findByRole("table");
		await waitFor(() => expect(screen.queryByRole("columnheader", { name: "Size" })).not.toBeInTheDocument());
		expect(screen.queryByRole("columnheader", { name: "Updated" })).not.toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
	});

	test("moves and deletes a file after confirming", async () => {
		const source = makeSource();
		renderManager(source);
		await screen.findByRole("table");

		await userEvent.click(screen.getByRole("button", { name: "Move or rename notes.txt" }));
		const move = await screen.findByRole("dialog", { name: "Move or rename notes.txt" });
		const input = within(move).getByLabelText("New path");
		await userEvent.clear(input);
		await userEvent.type(input, "docs/renamed.txt");
		await userEvent.click(within(move).getByRole("button", { name: "Move" }));
		await waitFor(() => expect(source.rename).toHaveBeenCalledWith("notes.txt", "docs/renamed.txt"));

		await userEvent.click(screen.getByRole("button", { name: "Delete notes.txt" }));
		const remove = await screen.findByRole("dialog", { name: "Delete notes.txt?" });
		await userEvent.click(within(remove).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(source.delete).toHaveBeenCalledWith("notes.txt"));
	});

	test("hides every action a source does not provide", async () => {
		renderManager(
			makeSource({ download: undefined, upload: undefined, delete: undefined, rename: undefined, preview: undefined }),
		);
		await screen.findByRole("table");
		expect(screen.queryByTestId("file-upload")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Preview pic.png" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Download pic.png" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Delete notes.txt" })).not.toBeInTheDocument();
	});
});

describe("FilePickerDialog", () => {
	test("selects one file over any source without a top-right close button", async () => {
		const source = makeSource();
		const onSelect = vi.fn();
		renderWithI18n(<FilePickerDialog source={source} open onOpenChange={() => {}} onSelect={onSelect} />);
		const dialog = await screen.findByRole("dialog", { name: "Choose a file" });
		expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
		await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Select notes.txt" }));
		await userEvent.click(within(dialog).getByRole("button", { name: "Select" }));
		expect(onSelect).toHaveBeenCalledWith([expect.objectContaining({ path: "notes.txt", kind: "file" })]);
	});

	test("selects several files when multiple mode is on", async () => {
		const onSelect = vi.fn();
		renderWithI18n(
			<FilePickerDialog source={makeSource()} open multiple onOpenChange={() => {}} onSelect={onSelect} />,
		);
		const dialog = await screen.findByRole("dialog", { name: "Choose files" });
		await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Select pic.png" }));
		await userEvent.click(within(dialog).getByRole("checkbox", { name: "Select notes.txt" }));
		await userEvent.click(within(dialog).getByRole("button", { name: "Select 2 files" }));
		expect(onSelect.mock.calls[0]?.[0]).toHaveLength(2);
	});
});
