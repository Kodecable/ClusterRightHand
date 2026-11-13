import { expect, test } from "@playwright/test";
import { login, mockApi, nodeView } from "./helpers";

const NODE = nodeView({ id: "node-1", name: "worker-01" });

test("the node Files tab lists, downloads and navigates with no upload or mutation actions", async ({ page }) => {
	await mockApi(page, {
		state: {
			nodes: [NODE],
			nodeFiles: {
				"node-1:/": [
					{ path: "/etc", name: "etc", type: "dir", size: 4096 },
					{ path: "/readme.txt", name: "readme.txt", type: "file", size: 12, mtime: "2026-01-01T00:00:00Z" },
				],
				"node-1:/etc": [{ path: "/etc/passwd", name: "passwd", type: "file", size: 10 }],
			},
		},
	});
	await login(page);
	await page.goto("/nodes/node-1");
	await expect(page.getByTestId("node-detail")).toBeVisible();
	await page.getByRole("tab", { name: "Files" }).click();

	const table = page.getByRole("table", { name: "Files in worker-01" });
	await expect(table).toContainText("readme.txt");
	await expect(table).toContainText("etc");
	// Nodes have no upload, delete or rename yet; a file downloads through its page endpoint.
	await expect(page.getByTestId("file-upload")).toHaveCount(0);
	const manager = page.getByTestId("node-file-manager");
	await expect(manager.getByRole("button", { name: "Download readme.txt" })).toHaveAttribute(
		"href",
		"/api/nodes/node-1/file?path=%2Freadme.txt",
	);
	await expect(manager.getByRole("button", { name: /^Delete/ })).toHaveCount(0);

	await page.getByRole("button", { name: "etc", exact: true }).click();
	await expect(page.getByRole("table", { name: "Files in etc" })).toContainText("passwd");
});
