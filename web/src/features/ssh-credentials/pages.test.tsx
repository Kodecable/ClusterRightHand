import type { SshCredential, User } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppSidebar } from "@/app/shell/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { authStore } from "@/features/auth/session";
import { renderWithRouter } from "@/test/render";
import { SshCredentialsPage } from "./pages";

const ADMIN: User = {
	id: "u1",
	username: "ops",
	displayName: "Ada Ops",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};
const MEMBER: User = { ...ADMIN, id: "u2", username: "alice", displayName: "Alice", kind: "member" };

const LONG_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTests laptop";

function credential(overrides: Partial<SshCredential> = {}): SshCredential {
	return {
		id: "cred-1",
		name: "laptop",
		publicKey: LONG_KEY,
		createdAt: "2026-01-01T00:00:00.000Z",
		usedBy: [],
		...overrides,
	};
}

interface MockApi {
	calls: { body: unknown; method: string; url: string }[];
	credentials: SshCredential[];
}

function mockApi(user: User, credentials: SshCredential[], options: { deleteStatus?: number } = {}): MockApi {
	const state: MockApi = { calls: [], credentials: credentials.map((item) => ({ ...item, usedBy: [...item.usedBy] })) };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
			state.calls.push({ body, method, url });
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), {
					status,
					headers: { "content-type": "application/json" },
				});
			if (url === "/api/me") return json({ user });
			if (url === "/api/approvals") {
				return json({ tasks: [], taskGroups: [], authorizations: { tasks: [], taskGroups: [] }, quotas: [] });
			}
			if (url === "/api/ssh-credentials" && method === "GET") return json({ credentials: state.credentials });
			if (url === "/api/ssh-credentials" && method === "POST") {
				const created = credential({
					id: `cred-${state.credentials.length + 1}`,
					name: (body as { name: string }).name,
					publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewKeyMaterial new",
					createdAt: "2026-01-02T00:00:00.000Z",
				});
				state.credentials.push(created);
				return json({ credential: created }, 201);
			}
			const match = /^\/api\/ssh-credentials\/([^/]+)$/.exec(url);
			if (match && method === "DELETE") {
				if (options.deleteStatus === 409) {
					return json({ error: "the credential is in use by a node" }, 409);
				}
				const id = decodeURIComponent(match[1] as string);
				state.credentials = state.credentials.filter((item) => item.id !== id);
				return json({ ok: true });
			}
			return json({});
		}),
	);
	return state;
}

async function renderPage(user: User, credentials: SshCredential[], options?: { deleteStatus?: number }) {
	const api = mockApi(user, credentials, options);
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<SshCredentialsPage />
		</QueryClientProvider>,
	);
	return api;
}

async function renderSidebar(user: User) {
	const api = mockApi(user, []);
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<SidebarProvider>
				<AppSidebar />
			</SidebarProvider>
		</QueryClientProvider>,
	);
	return api;
}

afterEach(() => {
	authStore.clear();
	vi.unstubAllGlobals();
});

describe("SshCredentialsPage", () => {
	test("lists credentials with their public key, creation time and using nodes", async () => {
		await renderPage(ADMIN, [
			credential({ usedBy: [{ id: "node-1", name: "worker-01" }] }),
			credential({ id: "cred-2", name: "unused", publicKey: "ssh-ed25519 AAAAC3NzaUnused unused", usedBy: [] }),
		]);

		expect(await screen.findByRole("heading", { name: "SSH credentials" })).toBeInTheDocument();
		expect(await screen.findByText("laptop")).toBeInTheDocument();
		expect(screen.getByText("unused")).toBeInTheDocument();
		expect(screen.getByTitle(LONG_KEY)).toBeInTheDocument();
		expect(screen.getByText("Not used")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/nodes/node-1");
		expect(screen.getAllByRole("button", { name: "Copy public key" })).toHaveLength(2);

		expect(screen.getByRole("button", { name: "Delete laptop" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Delete unused" })).toBeEnabled();
	});

	test("creates a credential and shows the public key to copy", async () => {
		const api = await renderPage(ADMIN, [credential()]);
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Create SSH credential" }));
		const dialog = await screen.findByRole("dialog", { name: "Create SSH credential" });
		await user.type(within(dialog).getByLabelText("Name"), "new key");
		await user.click(within(dialog).getByRole("button", { name: "Create" }));

		const created = await screen.findByTestId("ssh-credential-created-dialog");
		expect(within(created).getByText("SSH credential created")).toBeInTheDocument();
		expect(within(created).getByText(/AAAAC3NzaC1lZDI1NTE5AAAAINewKeyMaterial/)).toBeInTheDocument();
		expect(within(created).getByRole("button", { name: "Copy public key" })).toBeInTheDocument();
		expect(api.calls.find((call) => call.method === "POST" && call.url === "/api/ssh-credentials")?.body).toEqual({
			name: "new key",
		});

		await user.click(within(created).getByRole("button", { name: "Done" }));
		expect(await screen.findByText("new key")).toBeInTheDocument();
	});

	test("deletes an unused credential after confirmation", async () => {
		const api = await renderPage(ADMIN, [credential()]);
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Delete laptop" }));
		const dialog = await screen.findByRole("dialog", { name: 'Delete the SSH credential "laptop"?' });
		await user.click(within(dialog).getByRole("button", { name: "Delete credential" }));

		await waitFor(() => expect(screen.queryByRole("button", { name: "Delete laptop" })).not.toBeInTheDocument());
		expect(api.calls.find((call) => call.method === "DELETE")?.url).toBe("/api/ssh-credentials/cred-1");
	});

	test("keeps the confirmation open and shows the server message when the credential is in use", async () => {
		await renderPage(ADMIN, [credential()], { deleteStatus: 409 });
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Delete laptop" }));
		const dialog = await screen.findByRole("dialog", { name: 'Delete the SSH credential "laptop"?' });
		await user.click(within(dialog).getByRole("button", { name: "Delete credential" }));

		expect(await within(dialog).findByText("the credential is in use by a node")).toBeInTheDocument();
		expect(within(dialog).getByRole("button", { name: "Delete credential" })).toBeInTheDocument();
	});

	test("shows the not-allowed state to a non-administrator", async () => {
		const api = await renderPage(MEMBER, [credential()]);

		expect(await screen.findByText("Administrators only")).toBeInTheDocument();
		expect(screen.getByText("Only administrators can manage SSH credentials.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Create SSH credential" })).not.toBeInTheDocument();
		expect(api.calls.some((call) => call.url === "/api/ssh-credentials")).toBe(false);
	});
});

describe("SSH credentials navigation", () => {
	test("an administrator sees the SSH credentials entry", async () => {
		await renderSidebar(ADMIN);
		expect(await screen.findByTestId("nav-ssh-credentials")).toHaveTextContent("SSH credentials");
	});

	test("a member does not see the SSH credentials entry", async () => {
		await renderSidebar(MEMBER);
		expect(await screen.findByTestId("nav-nodes")).toBeInTheDocument();
		expect(screen.queryByTestId("nav-ssh-credentials")).not.toBeInTheDocument();
	});
});
