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
	effectiveDescription: "GitHub tools",
	descriptionSource: "admin",
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
	config: null,
	status: {
		state: "ready",
		lastError: null,
		nextAttemptAt: null,
		toolCount: 3,
		connected: false,
		refreshedAt: "2026-01-01T00:00:00.000Z",
	},
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const BUILTIN: ExtensionView = {
	id: "srv-docs",
	name: "crhs-docs",
	kind: "builtin",
	description: null,
	effectiveDescription: "The documentation",
	descriptionSource: "builtin",
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
	config: null,
	status: {
		state: "ready",
		lastError: null,
		nextAttemptAt: null,
		toolCount: 0,
		connected: false,
		refreshedAt: null,
	},
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const DS_SEARCH: ExtensionView = {
	...BUILTIN,
	id: "srv-ds",
	name: "crhs-ds-search",
	enabled: false,
	effectiveDescription: "Web search and page fetch",
	config: {
		fields: [
			{ key: "apiKey", label: "API key", kind: "secret", required: true, description: "A key", default: null },
			{
				key: "baseUrl",
				label: "Base URL",
				kind: "string",
				required: false,
				description: "The base URL",
				default: "https://api.deepseek.com",
			},
		],
		values: {},
		secretsSet: [],
		missing: ["apiKey"],
	},
};

function extensionWith(extension: ExtensionView, overrides: Partial<ExtensionView>): ExtensionView {
	return { ...extension, ...overrides };
}

interface MockOptions {
	/** The first list response; later ones return the full list, as if the page refreshed after connecting. */
	first?: ExtensionView[];
	/** State of the fake MCP extension after clicking Reconnect. */
	reconnect?: boolean;
	/** Bodies of the PUTs, by path. */
	saved?: { path: string; body: unknown }[];
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
		if (method === "PUT") {
			options.saved?.push({ path, body: JSON.parse(String(init?.body)) });
			return json({ extension: DS_SEARCH });
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
		if (path === "/api/extensions/crhs-docs/tools") {
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
		expect(screen.getByRole("button", { name: "Edit crhs-docs" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "View tools of crhs-docs" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reconnect crhs-docs" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Delete crhs-docs" })).not.toBeInTheDocument();
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
		expect(await screen.findByText("crhs-docs")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Edit crhs-docs" }));
		await waitFor(() => expect(screen.getByTestId("extension-dialog")).toBeInTheDocument());
		expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Timeout (seconds)")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Request headers")).not.toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Everyone" })).toBeChecked();
		// A built-in's description is a constant of crhs: shown, not editable.
		expect(screen.getByText("The documentation")).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Description" })).not.toBeInTheDocument();
	});

	test("sets a built-in's API key without showing it, and sends only what changed", async () => {
		const saved: { path: string; body: unknown }[] = [];
		mockApi({ first: [MCP, BUILTIN, DS_SEARCH], saved });
		await renderWithRouter(<ExtensionsPage />);
		expect(await screen.findByText("crhs-ds-search")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Edit crhs-ds-search" }));
		await waitFor(() => expect(screen.getByTestId("extension-dialog")).toBeInTheDocument());
		const key = screen.getByLabelText(/API key/);
		expect(key).toHaveAttribute("type", "password");
		expect(screen.getByLabelText("Base URL")).toHaveAttribute("placeholder", "https://api.deepseek.com");
		fireEvent.change(key, { target: { value: "sk-test" } });
		fireEvent.click(screen.getByRole("checkbox", { name: "Enabled (a disabled extension is invisible to sessions)" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(saved).toHaveLength(1));
		expect(saved[0]?.path).toBe("/api/extensions/crhs-ds-search");
		expect(saved[0]?.body).toMatchObject({ enabled: true, config: { apiKey: "sk-test" } });
		const body = saved[0]?.body as { config: Record<string, unknown> } | undefined;
		expect(body?.config).not.toHaveProperty("baseUrl");
	});

	test("leaves an MCP description empty and shows what the server reports instead", async () => {
		const reported = extensionWith(MCP, {
			description: null,
			effectiveDescription: "Use these tools to manage GitHub issues.",
			descriptionSource: "instructions",
		});
		mockApi({ first: [reported, BUILTIN] });
		await renderWithRouter(<ExtensionsPage />);
		expect(await screen.findByText("github")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Edit github" }));
		await waitFor(() => expect(screen.getByTestId("extension-dialog")).toBeInTheDocument());
		const field = screen.getByRole("textbox", { name: "Description" });
		// Never prefilled: saving would otherwise freeze the server's current text as the administrator's.
		expect(field).toHaveValue("");
		expect(field).toHaveAttribute("placeholder", "Use these tools to manage GitHub issues.");
	});

	test("refreshes the list after the Tools dialog connects", async () => {
		mockApi({
			first: [
				extensionWith(MCP, {
					grants: [],
					status: {
						state: "unknown",
						lastError: null,
						nextAttemptAt: null,
						toolCount: 0,
						connected: false,
						refreshedAt: null,
					},
				}),
				BUILTIN,
			],
		});
		await renderWithRouter(<ExtensionsPage />);
		expect(await screen.findByText("Not listed yet")).toBeInTheDocument();
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
						connected: false,
						refreshedAt: null,
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
