import type { McpServerView } from "@crh/api";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { McpServersPage } from "./mcp-servers";

const SERVER: McpServerView = {
	id: "srv-1",
	name: "github",
	description: "GitHub tools",
	url: "https://mcp.github.test/mcp",
	hasHeaders: true,
	headerNames: ["Authorization"],
	identityHeaders: { username: null, session: null },
	enabled: true,
	listDirectly: true,
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

function serverWith(overrides: Partial<McpServerView>): McpServerView {
	return { ...SERVER, ...overrides };
}

interface MockOptions {
	/** The first list response; later ones return SERVER, as if the page refreshed after connecting. */
	first?: McpServerView;
	/** State of the fake server after clicking Reconnect; the status list then reports ready. */
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
		if (path === "/api/mcp-servers") {
			listCalls += 1;
			const server = listCalls === 1 ? (options.first ?? SERVER) : SERVER;
			return json({ servers: [{ ...server, status: reconnected ? SERVER.status : server.status }] });
		}
		if (method === "POST" && path === "/api/mcp-servers/github/reconnect") {
			reconnected = true;
			return json({ status: SERVER.status });
		}
		if (path === "/api/mcp-servers/github/tools") {
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
				status: SERVER.status,
			});
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

describe("MCP servers settings page", () => {
	test("names the two status columns and shows the grants in Access", async () => {
		mockApi();
		await renderWithRouter(<McpServersPage />);
		expect(await screen.findByText("github")).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Connection" })).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Enabled" })).toBeInTheDocument();
		expect(screen.queryByRole("columnheader", { name: "State" })).not.toBeInTheDocument();
		expect(screen.queryByRole("columnheader", { name: "Status" })).not.toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Access" })).toBeInTheDocument();
		// Both grantees are shown by name, compactly.
		expect(screen.getByText("Ada, Platform")).toBeInTheDocument();
		expect(screen.queryByText("u1")).not.toBeInTheDocument();
		// Four icon buttons with tooltips and labels, so they fit at 1280px.
		expect(screen.getByRole("button", { name: "Edit github" })).toHaveAttribute("title", "Edit");
		expect(screen.getByRole("button", { name: "View tools of github" })).toHaveAttribute("title", "Tools");
		expect(screen.getByRole("button", { name: "Reconnect github" })).toHaveAttribute("title", "Reconnect");
		expect(screen.getByRole("button", { name: "Delete github" })).toHaveAttribute("title", "Delete");
	});

	test("lists a server with its state and opens the tools and create dialog", async () => {
		mockApi();
		await renderWithRouter(<McpServersPage />);
		expect(await screen.findByText("github")).toBeInTheDocument();
		expect(screen.getByText("Ready")).toBeInTheDocument();
		expect(screen.getByText("https://mcp.github.test/mcp")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "View tools of github" }));
		expect(await screen.findByTestId("mcp-tool-list")).toHaveTextContent("create_issue");

		fireEvent.click(screen.getByTestId("add-mcp-server"));
		await waitFor(() => expect(screen.getByTestId("mcp-server-dialog")).toBeInTheDocument());
		expect(screen.getByLabelText("Name")).toBeInTheDocument();
		expect(screen.getByLabelText("URL")).toBeInTheDocument();
	});

	test("refreshes the list after the Tools dialog connects", async () => {
		mockApi({
			first: serverWith({
				grants: [],
				status: { state: "unknown", lastError: null, nextAttemptAt: null, toolCount: 0 },
			}),
		});
		await renderWithRouter(<McpServersPage />);
		expect(await screen.findByText("Not connected yet")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "View tools of github" }));
		expect(await screen.findByTestId("mcp-tool-list")).toHaveTextContent("create_issue");
		// Listing connected to the server; the table now shows the fresh status without a reload.
		await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
	});

	test("refreshes the list after Reconnect", async () => {
		mockApi({
			first: serverWith({
				grants: [],
				status: {
					state: "unavailable",
					lastError: "connection refused",
					nextAttemptAt: "2026-01-01T00:05:00.000Z",
					toolCount: 0,
				},
			}),
			reconnect: true,
		});
		await renderWithRouter(<McpServersPage />);
		expect(await screen.findByText("Unavailable")).toBeInTheDocument();
		const toolsButton = screen.getByRole("button", { name: "Reconnect github" });
		expect(toolsButton).toBeInTheDocument();
		fireEvent.click(toolsButton);
		await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});
