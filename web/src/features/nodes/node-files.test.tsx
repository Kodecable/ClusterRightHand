import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { NodeFiles } from "./node-files";

function mockFiles(): { urls: string[] } {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			const path = new URL(url, "http://localhost").searchParams.get("path") ?? "/";
			if (url.includes("/file?")) {
				return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			}
			if (url.includes("/stat?")) {
				return new Response(JSON.stringify({ file: { path, size: 4, mtime: "2026-01-01T00:00:00Z" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			const entries =
				path === "/"
					? [
							{ path: "/etc", name: "etc", type: "dir", size: 0 },
							{ path: "/pic.png", name: "pic.png", type: "file", size: 4, mtime: "2026-01-01T00:00:00Z" },
							{ path: "/readme.txt", name: "readme.txt", type: "file", size: 12, mtime: "2026-01-01T00:00:00Z" },
						]
					: [{ path: "/etc/passwd", name: "passwd", type: "file", size: 10, mtime: "2026-01-01T00:00:00Z" }];
			return new Response(JSON.stringify({ path, entries, truncated: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return { urls };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("node Files tab", () => {
	beforeEach(() => {
		Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:preview"), configurable: true });
	});

	test("lists the root, navigates into a directory and offers no mutating actions", async () => {
		const { urls } = mockFiles();
		renderWithI18n(<NodeFiles nodeId="node-1" nodeName="web-1" />);
		expect(await screen.findByText("readme.txt")).toBeInTheDocument();
		expect(screen.getByText("etc")).toBeInTheDocument();
		expect(urls[0]).toContain("/api/nodes/node-1/files?path=%2F");
		// Nodes have no upload, download, delete or rename yet; only a preview appears for an image.
		expect(screen.queryByTestId("file-upload")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Download/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Move or rename/ })).not.toBeInTheDocument();

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Preview pic.png" }));
		expect(await screen.findByTestId("file-preview-image")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Close" }));

		await user.click(screen.getByText("etc"));
		expect(await screen.findByText("passwd")).toBeInTheDocument();
		await waitFor(() => expect(urls.some((url) => url.includes("path=%2Fetc"))).toBe(true));
	});
});
