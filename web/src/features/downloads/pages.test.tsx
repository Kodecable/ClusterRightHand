import type { LibraryView } from "@crh/api";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startDownload } from "@/lib/file-urls";
import { renderWithRouter } from "@/test/render";
import { DownloadPage, parseDownloadTarget } from "./pages";

vi.mock("@/lib/file-urls", async (original) => ({
	...(await original<typeof import("@/lib/file-urls")>()),
	startDownload: vi.fn(),
}));

const TEAM_LIBRARY = {
	id: "lib-team",
	ref: "user_group:team",
	ownerKind: "user_group",
	ownerId: "group-1",
	ownerName: "team",
	ownerDisplayName: "team",
	usage: { files: 1, bytes: 5 },
	limits: { files: 0, fileBytes: 0, totalBytes: 0 },
	capabilities: { write: true, manage: false },
} satisfies LibraryView;

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** Answers the library list, the node list and the stats; `missing` paths answer 404 like a denied file. */
function mockApi(missing: readonly string[] = []) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://localhost");
		const path = decodeURIComponent(url.pathname);
		const filePath = url.searchParams.get("path") ?? "";
		if (path === "/api/libraries") return json({ libraries: [TEAM_LIBRARY] });
		if (path === "/api/nodes") return json({ nodes: [{ id: "node-1", name: "worker-01" }] });
		if (path.endsWith("/stat")) {
			if (missing.includes(filePath)) return json({ error: "not found" }, 404);
			return json({ file: { path: filePath, size: 2048, mediaType: "text/plain" } });
		}
		return json({});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const statCalls = (fetchMock: ReturnType<typeof mockApi>) =>
	fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/stat"));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.mocked(startDownload).mockClear();
});

describe("DownloadPage", () => {
	test("resolves a library by its id, shows the file and starts its download once", async () => {
		const fetchMock = mockApi();
		// The reference in the link is the group's old name; the id finds the renamed library.
		await renderWithRouter(<DownloadPage />, "en", {
			initialEntries: ["/?libraryId=lib-team&library=user_group%3Aold&path=docs%2Freport.txt"],
		});
		const link = await screen.findByTestId("download-file-download");
		expect(link).toHaveAttribute("href", "/api/libraries/user_group%3Ateam/file?path=docs%2Freport.txt");
		expect(screen.getByTestId("download-file")).toHaveTextContent("report.txt");
		expect(screen.getByTestId("download-file")).toHaveTextContent("user_group:team");
		expect(statCalls(fetchMock).some((url) => url.includes("/libraries/user_group%3Ateam/stat"))).toBe(true);
		expect(startDownload).toHaveBeenCalledTimes(1);
		expect(startDownload).toHaveBeenCalledWith(
			"/api/libraries/user_group%3Ateam/file?path=docs%2Freport.txt",
			"report.txt",
		);
	});

	test("falls back to the reference for a library the list does not show", async () => {
		mockApi();
		await renderWithRouter(<DownloadPage />, "en", {
			initialEntries: ["/?libraryId=lib-other&library=user%3Abob&path=a.txt"],
		});
		const link = await screen.findByTestId("download-file-download");
		expect(link).toHaveAttribute("href", "/api/libraries/user%3Abob/file?path=a.txt");
	});

	test("a missing or unreachable file gets one message and no download", async () => {
		mockApi(["docs/gone.txt"]);
		await renderWithRouter(<DownloadPage />, "en", {
			initialEntries: ["/?libraryId=lib-team&library=user_group%3Ateam&path=docs%2Fgone.txt"],
		});
		expect(await screen.findByText("This file doesn't exist or you don't have access.")).toBeInTheDocument();
		expect(screen.queryByTestId("download-file")).not.toBeInTheDocument();
		expect(startDownload).not.toHaveBeenCalled();
	});

	test("a node file is checked on its node and downloads through the node file endpoint", async () => {
		const fetchMock = mockApi();
		await renderWithRouter(<DownloadPage />, "en", {
			initialEntries: ["/?nodeId=node-1&path=%2Fvar%2Flog%2Fapp.log"],
		});
		const link = await screen.findByTestId("download-file-download");
		expect(link).toHaveAttribute("href", "/api/nodes/node-1/file?path=%2Fvar%2Flog%2Fapp.log");
		expect(await screen.findByText("worker-01")).toBeInTheDocument();
		expect(statCalls(fetchMock).some((url) => url.includes("/nodes/node-1/stat"))).toBe(true);
		expect(startDownload).toHaveBeenCalledWith("/api/nodes/node-1/file?path=%2Fvar%2Flog%2Fapp.log", "app.log");
	});

	test("a link without a file says so", async () => {
		mockApi();
		await renderWithRouter(<DownloadPage />, "en", { initialEntries: ["/?libraryId=lib-team"] });
		expect(await screen.findByText("This download link is incomplete.")).toBeInTheDocument();
		expect(startDownload).not.toHaveBeenCalled();
	});
});

describe("parseDownloadTarget", () => {
	test("keeps every value a string, as the link wrote it", () => {
		expect(parseDownloadTarget("?nodeId=123&path=007")).toEqual({ kind: "node", nodeId: "123", path: "007" });
		expect(parseDownloadTarget("?library=user%3Aa&path=true")).toEqual({
			kind: "library",
			libraryId: undefined,
			library: "user:a",
			path: "true",
		});
		expect(parseDownloadTarget("?path=a.txt")).toBeUndefined();
	});
});
