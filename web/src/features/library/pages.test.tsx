import type { LibraryFile, LibraryView, User } from "@crh/api";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/lib/session";
import { renderWithRouter } from "@/test/render";
import { LibraryPage } from "./pages";

const MEMBER: User = {
	id: "user-1",
	username: "ops",
	displayName: "Ada Ops",
	email: null,
	kind: "member",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const ADMIN: User = { ...MEMBER, id: "user-2", username: "root", displayName: "Root", kind: "admin" };

const OPS_LIBRARY: LibraryView = {
	id: "lib-ops",
	ref: "user:ops",
	ownerKind: "user",
	ownerId: MEMBER.id,
	ownerName: "ops",
	ownerDisplayName: "Ada Ops",
	usage: { files: 1, bytes: 5 },
	limits: { files: 256, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 },
	capabilities: { write: true, manage: false },
};

const TEAM_LIBRARY: LibraryView = {
	id: "lib-team",
	ref: "user_group:team",
	ownerKind: "user_group",
	ownerId: "group-1",
	ownerName: "team",
	ownerDisplayName: "team",
	usage: { files: 0, bytes: 0 },
	limits: { files: 0, fileBytes: 0, totalBytes: 0 },
	capabilities: { write: true, manage: false },
};

const NOTE: LibraryFile = {
	path: "docs/notes.txt",
	size: 5,
	sha256: "a".repeat(64),
	mediaType: "text/plain",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const PNG: LibraryFile = {
	path: "docs/pic.png",
	size: 10,
	sha256: "b".repeat(64),
	mediaType: "image/png",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function mockApi({
	user = MEMBER,
	libraries = [OPS_LIBRARY, TEAM_LIBRARY],
	library = OPS_LIBRARY,
}: {
	user?: User;
	libraries?: LibraryView[];
	library?: LibraryView;
} = {}) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			const path = decodeURIComponent(url.pathname);
			if (path === "/api/me") return json({ user });
			if (path === "/api/libraries") return json({ libraries });
			if (path === "/api/libraries/user:ops" || path === "/api/libraries/user_group:team") {
				return json({ library: path.endsWith("team") ? TEAM_LIBRARY : library });
			}
			if (path === "/api/libraries/user:ops/files") {
				const prefix = url.searchParams.get("prefix") ?? "";
				if (prefix === "docs") return json({ prefix, files: [PNG], directories: [] });
				return json({ prefix, files: [NOTE], directories: ["docs"] });
			}
			return json({ error: "not found" }, 404);
		}),
	);
}

afterEach(() => {
	authStore.clear();
	vi.unstubAllGlobals();
});

async function renderPage(user: User = MEMBER) {
	mockApi({ user });
	await authStore.load();
	return renderWithRouter(<LibraryPage />, "en", {
		path: "/library/$library",
		initialEntries: ["/library/user%3Aops"],
	});
}

describe("LibraryPage", () => {
	test("shows one library control and the compact usage, and keeps the directory in the URL", async () => {
		const { router } = await renderPage();
		expect(await screen.findByRole("heading", { name: "Library" })).toBeVisible();
		expect(screen.getByTestId("library-selector")).toHaveTextContent("User Ada Ops's library");
		expect(screen.getByTestId("library-usage")).toHaveTextContent("0%");
		expect(screen.queryByText("User library of ops")).not.toBeInTheDocument();

		const table = await screen.findByRole("table", { name: "Files in User Ada Ops's library" });
		expect(within(table).getByText("notes.txt")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "docs" }));
		expect(router.state.location.search).toEqual({ path: "docs" });
		expect(await screen.findByRole("table", { name: "Files in docs" })).toHaveTextContent("pic.png");
	});

	test("switches to a user group library from the same control", async () => {
		await renderPage();
		await userEvent.click(await screen.findByRole("combobox", { name: "Library" }));
		await userEvent.click(await screen.findByRole("option", { name: /team/ }));
		expect(await screen.findByTestId("library-selector")).toHaveTextContent("User group team's library");
	});

	test("warns when a library is at a limit", async () => {
		const full: LibraryView = {
			...OPS_LIBRARY,
			usage: { files: 256, bytes: OPS_LIBRARY.limits.totalBytes },
		};
		mockApi({ library: full });
		await authStore.load();
		await renderWithRouter(<LibraryPage />, "en", {
			path: "/library/$library",
			initialEntries: ["/library/user%3Aops"],
		});
		const usage = await screen.findByTestId("library-usage");
		expect(usage).toHaveTextContent("100%");
		expect(usage.querySelector('[data-slot="progress"]')?.className).toContain("bg-warn");
	});

	test("lets an administrator pick any user or group library", async () => {
		await renderPage(ADMIN);
		expect(await screen.findByRole("combobox", { name: "Library" })).toBeVisible();
		expect(screen.queryByRole("combobox", { name: "Open any library" })).not.toBeInTheDocument();
		expect(screen.getByTestId("library-selector")).toHaveTextContent("User Ada Ops's library");
	});

	test("shows one message for a missing or inaccessible library", async () => {
		mockApi();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const path = decodeURIComponent(new URL(String(input), "http://localhost").pathname);
				if (path === "/api/me") return json({ user: MEMBER });
				if (path === "/api/libraries") return json({ libraries: [OPS_LIBRARY] });
				return json({ error: "no such library" }, 404);
			}),
		);
		await authStore.load();
		await renderWithRouter(<LibraryPage />, "en", {
			path: "/library/$library",
			initialEntries: ["/library/user%3Aother"],
		});
		expect(await screen.findByText("This library doesn't exist or you don't have access.")).toBeVisible();
	});
});
