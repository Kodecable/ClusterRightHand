import type { ExtensionView } from "@crh/api";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ExtensionsPage } from "./extensions";

const MCP: ExtensionView = {
	id: "srv-1",
	name: "github",
	kind: "mcp",
	description: "GitHub tools",
	url: "https://mcp.github.test/mcp",
	hasHeaders: true,
	headerNames: ["Authorization"],
	identityHeaders: { username: null, session: null },
	enabled: true,
	listDirectly: true,
	availability: "granted",
	trustAnnotations: true,
	timeoutSeconds: 300,
	grants: [
		{ granteeType: "user", granteeId: "u1" },
		{ granteeType: "user_group", granteeId: "g1" },
	],
	status: { state: "ready", lastError: null, nextAttemptAt: null, toolCount: 3 },
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const BUILTIN: ExtensionView = {
	id: "srv-docs",
	name: "docs",
	kind: "builtin",
	description: "The documentation",
	url: null,
	hasHeaders: false,
	headerNames: [],
	identityHeaders: { username: null, session: null },
	enabled: true,
	listDirectly: true,
	availability: "everyone",
	trustAnnotations: null,
	timeoutSeconds: null,
	grants: [],
	status: { state: "ready", lastError: null, nextAttemptAt: null, toolCount: 0 },
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function extensionWith(extension: ExtensionView, overrides: Partial<ExtensionView>): ExtensionView {
	return { ...extension, ...overrides };
}

interface MockOptions {
	/** The first list response; later ones return the full list, as if the page refreshed after connecting. */
	first?: ExtensionView[];
	/** State of the fake MCP extension after clicking Reconnect. */
	reconnect?: boolean;
}

function mockApi(options: MockOptions = {}) {
	let listCalls = 0;
	let reconnected = false;
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input), "http://localhost").pathname;
		const method = init?.method ?? "GET";
		const json = (payload: unknown) =>
			new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
		if (path === "/api/extensions") {
			listCalls += 1;
			const extensions = listCalls === 1 ? (options.first ?? [MCP, BUILTIN]) : [MCP, BUILTIN];
			return json({
				extensions: extensions.map((extension) =>
					extension.name === "github" && reconnected ? { ...extension, status: MCP.status } : extension,
				),
			});
		}
		if (method === "POST" && path === "/api/extensions/github/reconnect") {
			reconnected = true;
			return json({ status: MCP.status });
		}
		if (path === "/api/extensions/github/tools") {
			return json({
				tools: [
					{
						name: "create_issue",
						title: "Create issue",
						description: "Open an issue",
						inputSchema: { type: "object" },
						annotations: { readOnlyHint: false },
					},
				],
				status: MCP.status,
			});
		}
		if (path === "/api/extensions/docs/tools") {
			return json({ tools: [], status: BUILTIN.status });
		}
		if (path === "/api/directory") {
			return json({
				users: [{ id: "u1", username: "ada", displayName: "Ada" }],
				userGroups: [{ id: "g1", name: "Platform" }],
			});
		}
		return json({});
	});
	vi.stubGlobal("fetch", fetchMock);
	return { listCalls: () => listCalls };
}

describe("extensions settings page", () => {
	test("lists both kinds with their kind, state, tools and availability", async () => {
		mockApi();
		await renderWithRouter(<ExtensionsPage />);
		expect(await screen.findByText("github")).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Kind" })).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Connection" })).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Availability" })).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Enabled" })).toBeInTheDocument();
		expect(screen.getByText("MCP")).toBeInTheDocument();
		expect(screen.getByText("Built-in")).toBeInTheDocument();
		// The granted names are shown compactly; everyone is named as such.
		expect(screen.getByText("Ada, Platform")).toBeInTheDocument();
		expect(screen.queryByText("u1")).not.toBeInTheDocument();
		expect(screen.getByText("Everyone")).toBeInTheDocument();
		// The MCP extension has all four actions; the built-in only edit and tools.
		expect(screen.getByRole("button", { name: "Edit github" })).toHaveAttribute("title", "Edit");
		expect(screen.getByRole("button", { name: "View tools of github" })).toHaveAttribute("title", "Tools");
		expect(screen.getByRole("button", { name: "Reconnect github" })).toHaveAttribute("title", "Reconnect");
		expect(screen.getByRole("button", { name: "Delete github" })).toHaveAttribute("title", "Delete");
		expect(screen.getByRole("button", { name: "Edit docs" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "View tools of docs" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reconnect docs" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Delete docs" })).not.toBeInTheDocument();
	});

	test("opens the tools and the create dialog, with the availability control", async () => {
		mockApi();
		await renderWithRouter(<ExtensionsPage />);
		expect(await screen.findByText("github")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "View tools of github" }));
		expect(await screen.findByTestId("extension-tool-list")).toHaveTextContent("create_issue");

		fireEvent.click(screen.getByTestId("add-extension"));
		await waitFor(() => expect(screen.getByTestId("extension-dialog")).toBeInTheDocument());
		expect(screen.getByLabelText("Name")).toBeInTheDocument();
		expect(screen.getByLabelText("URL")).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Everyone" })).not.toBeChecked();
		expect(screen.getByRole("radio", { name: "Only granted users and groups" })).toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: "List its tools directly in the model's tool list" }),
		).not.toBeChecked();
	});

	test("edits a built-in without the MCP-only fields", async () => {
		mockApi();
		await renderWithRouter(<ExtensionsPage />);
		expect(await screen.findByText("docs")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Edit docs" }));
		await waitFor(() => expect(screen.getByTestId("extension-dialog")).toBeInTheDocument());
		expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Timeout (seconds)")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Request headers")).not.toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Everyone" })).toBeChecked();
		expect(screen.getByLabelText("Description")).toBeInTheDocument();
	});

	test("refreshes the list after the Tools dialog connects", async () => {
		mockApi({
			first: [
				extensionWith(MCP, {
					grants: [],
					status: { state: "unknown", lastError: null, nextAttemptAt: null, toolCount: 0 },
				}),
				BUILTIN,
			],
		});
		await renderWithRouter(<ExtensionsPage />);
		expect(await screen.findByText("Not connected yet")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "View tools of github" }));
		expect(await screen.findByTestId("extension-tool-list")).toHaveTextContent("create_issue");
		// Listing connected to the extension; the table now shows the fresh status without a reload.
		await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
	});

	test("refreshes the list after Reconnect", async () => {
		mockApi({
			first: [
				extensionWith(MCP, {
					grants: [],
					status: {
						state: "unavailable",
						lastError: "connection refused",
						nextAttemptAt: "2026-01-01T00:05:00.000Z",
						toolCount: 0,
					},
				}),
				BUILTIN,
			],
			reconnect: true,
		});
		await renderWithRouter(<ExtensionsPage />);
		expect(await screen.findByText("Unavailable")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reconnect github" }));
		await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});
