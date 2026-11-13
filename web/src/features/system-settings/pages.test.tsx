import type { SigningKey, SystemSettings } from "@crh/api";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { SystemSettingsPage } from "./pages";

const SETTINGS: SystemSettings = {
	publicUrl: null,
	clockWarn: "60s",
	retention: { tasks: "90d", audit: "180d", piTasks: "7d" },
	webauthn: { rpId: null, rpName: "ClusterRightHand", origins: [] },
	auth: { captcha: "cap", argon2Concurrency: 2, argon2Queue: 32 },
	realIpHeader: null,
	library: {
		user: { files: 256, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 },
		group: { files: 0, fileBytes: 0, totalBytes: 0 },
	},
};

const DEFAULTS: SystemSettings = {
	publicUrl: null,
	clockWarn: "60s",
	retention: { tasks: "90d", audit: "180d", piTasks: "7d" },
	webauthn: { rpId: null, rpName: "ClusterRightHand", origins: [] },
	auth: { captcha: "cap", argon2Concurrency: 2, argon2Queue: 32 },
	realIpHeader: null,
	library: {
		user: { files: 256, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 },
		group: { files: 0, fileBytes: 0, totalBytes: 0 },
	},
};

const NEWEST_KEY: SigningKey = {
	id: "key-new",
	publicKey: "ssh-ed25519 AAAANEWKEY crhs-signing",
	fingerprint: "SHA256:newest-key",
	createdAt: "2026-02-01T10:00:00.000Z",
	trustedBy: [{ nodeId: "node-1", nodeName: "web-1", kinds: ["execute", "cosign"] }],
};

const OLDER_KEY: SigningKey = {
	id: "key-old",
	publicKey: "ssh-ed25519 AAAAOLDKEY crhs-signing",
	fingerprint: "SHA256:older-key",
	createdAt: "2026-01-01T10:00:00.000Z",
	trustedBy: [],
};

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function mergeSettings(settings: SystemSettings, patch: Record<string, unknown>): SystemSettings {
	return {
		...settings,
		...(patch.publicUrl !== undefined ? { publicUrl: patch.publicUrl as string | null } : {}),
		...(patch.clockWarn !== undefined ? { clockWarn: patch.clockWarn as string } : {}),
		...(patch.realIpHeader !== undefined ? { realIpHeader: patch.realIpHeader as string | null } : {}),
		...(patch.retention !== undefined ? { retention: { ...settings.retention, ...(patch.retention as object) } } : {}),
		...(patch.webauthn !== undefined ? { webauthn: { ...settings.webauthn, ...(patch.webauthn as object) } } : {}),
		...(patch.auth !== undefined ? { auth: { ...settings.auth, ...(patch.auth as object) } } : {}),
		...(patch.library !== undefined
			? {
					library: {
						user: { ...settings.library.user, ...((patch.library as { user?: object }).user ?? {}) },
						group: { ...settings.library.group, ...((patch.library as { group?: object }).group ?? {}) },
					},
				}
			: {}),
	};
}

function mockApi({
	settings = SETTINGS,
	keys = [NEWEST_KEY, OLDER_KEY],
}: {
	settings?: SystemSettings;
	keys?: SigningKey[];
} = {}) {
	const state = { settings: structuredClone(settings), keys: structuredClone(keys) };
	const calls: Call[] = [];
	let patchResponse: ((body: Record<string, unknown>) => Response) | undefined;
	let deleteResponse: ((id: string, body: Record<string, unknown>) => Response | null) | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			calls.push({ url, method, body });
			if (url === "/api/settings" && method === "GET") {
				return json({ settings: state.settings, defaults: DEFAULTS });
			}
			if (url === "/api/settings" && method === "PATCH") {
				if (patchResponse !== undefined) return patchResponse(body ?? {});
				state.settings = mergeSettings(state.settings, body ?? {});
				return json({ settings: state.settings });
			}
			if (url === "/api/privilege/signing-keys" && method === "GET") {
				return json({ keys: state.keys });
			}
			if (url === "/api/privilege/signing-keys" && method === "POST") {
				const key: SigningKey = {
					...NEWEST_KEY,
					id: "key-created",
					trustedBy: [],
					createdAt: "2026-03-01T10:00:00.000Z",
				};
				state.keys = [key, ...state.keys];
				return json({ key }, 201);
			}
			const deletion = /^\/api\/privilege\/signing-keys\/([^/]+)$/.exec(url);
			if (deletion !== null && method === "DELETE") {
				const id = decodeURIComponent(deletion[1] ?? "");
				const override = deleteResponse?.(id, body ?? {});
				if (override !== undefined && override !== null) return override;
				state.keys = state.keys.filter((key) => key.id !== id);
				return json({ ok: true });
			}
			return json({});
		}),
	);
	return {
		calls,
		state,
		setPatchResponse: (handler: (body: Record<string, unknown>) => Response) => {
			patchResponse = handler;
		},
		setDeleteResponse: (handler: (id: string, body: Record<string, unknown>) => Response | null) => {
			deleteResponse = handler;
		},
	};
}

async function renderPage() {
	await renderWithRouter(<SystemSettingsPage />);
	return screen.findByRole("heading", { name: "System settings" });
}

function section(testId: string): HTMLElement {
	return screen.getByTestId(testId);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("SystemSettingsPage", () => {
	test("loads every section with the current values and defaults", async () => {
		mockApi();
		await renderPage();

		for (const name of ["General", "Sign-in", "Passkeys", "Data retention", "Authorization signing keys"]) {
			expect(screen.getByRole("heading", { name })).toBeVisible();
		}
		expect(within(section("general-section")).getByLabelText("Public URL")).toHaveValue("");
		expect(within(section("general-section")).getByLabelText("Clock warning threshold")).toHaveValue("60s");
		expect(within(section("general-section")).getByText(/Default: 60s/)).toBeVisible();

		expect(within(section("sign-in-section")).getByLabelText("Captcha")).toHaveTextContent("Cap proof of work");
		expect(within(section("sign-in-section")).getByLabelText("Argon2 concurrency")).toHaveValue(2);
		expect(within(section("sign-in-section")).getByLabelText("Argon2 queue")).toHaveValue(32);

		// The newest key comes first and is marked; it is the one crhs signs with. The table shows
		// only how many nodes trust a key; their names are in the delete dialog.
		await screen.findByRole("table", { name: "Authorization signing keys" });
		const rows = within(screen.getByRole("table", { name: "Authorization signing keys" })).getAllByRole("row");
		const newest = rows[1];
		if (newest === undefined) throw new Error("no newest key row");
		expect(newest).toHaveTextContent("SHA256:newest-key");
		expect(newest).toHaveTextContent("Newest");
		expect(newest).toHaveTextContent("1 node");
		expect(within(newest).queryByRole("link")).not.toBeInTheDocument();

		const older = rows[2];
		if (older === undefined) throw new Error("no older key row");
		expect(older).toHaveTextContent("None");
		expect(older).not.toHaveTextContent("Newest");
	});

	test("shows the Chinese section names", async () => {
		mockApi();
		await renderWithRouter(<SystemSettingsPage />, "zh-CN");

		expect(await screen.findByRole("heading", { name: "系统设置" })).toBeVisible();
		for (const name of ["常规", "登录", "Passkey", "数据保留", "资料库默认值", "授权签名密钥"]) {
			expect(screen.getByRole("heading", { name })).toBeVisible();
		}
	});

	test("saves only the General section's fields", async () => {
		const api = mockApi();
		await renderPage();
		const general = section("general-section");
		const save = within(general).getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();

		await userEvent.type(within(general).getByLabelText("Public URL"), "https://crh.example.com");
		await userEvent.clear(within(general).getByLabelText("Clock warning threshold"));
		await userEvent.type(within(general).getByLabelText("Clock warning threshold"), "5m");
		expect(save).toBeEnabled();
		await userEvent.click(save);

		await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
		const patch = api.calls.find((call) => call.method === "PATCH");
		expect(patch?.body).toEqual({ publicUrl: "https://crh.example.com", clockWarn: "5m" });
		await waitFor(() => expect(save).toBeDisabled());
	});

	test("saves only the Sign-in section's fields and warns about risky choices", async () => {
		const api = mockApi();
		await renderPage();
		const signIn = section("sign-in-section");

		await userEvent.click(within(signIn).getByLabelText("Captcha"));
		await userEvent.click(await screen.findByRole("option", { name: "No captcha" }));
		expect(await screen.findByText(/sign-in has no proof of work/)).toBeVisible();

		await userEvent.type(within(signIn).getByLabelText("Real client IP header"), "X-Forwarded-For");
		expect(await screen.findByText(/must overwrite this header/)).toBeVisible();
		await userEvent.clear(within(signIn).getByLabelText("Argon2 concurrency"));
		await userEvent.type(within(signIn).getByLabelText("Argon2 concurrency"), "4");
		await userEvent.clear(within(signIn).getByLabelText("Argon2 queue"));
		await userEvent.type(within(signIn).getByLabelText("Argon2 queue"), "8");
		await userEvent.click(within(signIn).getByRole("button", { name: "Save" }));

		await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
		expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
			auth: { captcha: "none", argon2Concurrency: 4, argon2Queue: 8 },
			realIpHeader: "X-Forwarded-For",
		});
	});

	test("edits the Passkey origins list and saves only the Passkeys section", async () => {
		const api = mockApi();
		await renderPage();
		const passkeys = section("passkeys-section");

		await userEvent.type(within(passkeys).getByLabelText("Relying party ID"), "crh.example.com");
		await userEvent.click(within(passkeys).getByTestId("add-origin"));
		await userEvent.type(within(passkeys).getByLabelText("Allowed origin 1"), "https://crh.example.com");
		await userEvent.click(within(passkeys).getByRole("button", { name: "Save" }));

		await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
		expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
			webauthn: {
				rpId: "crh.example.com",
				rpName: "ClusterRightHand",
				origins: ["https://crh.example.com"],
			},
		});
	});

	test("saves durations and Keep forever in the Data retention section", async () => {
		const api = mockApi();
		await renderPage();
		const retention = section("retention-section");

		await userEvent.clear(within(retention).getByLabelText("Tasks"));
		await userEvent.type(within(retention).getByLabelText("Tasks"), "30d");
		const audit = within(retention).getByLabelText("Audit events").closest('[data-slot="field"]');
		if (!(audit instanceof HTMLElement)) throw new Error("no audit field");
		await userEvent.click(within(audit).getByRole("checkbox", { name: "Keep forever" }));
		expect(within(retention).getByLabelText("Audit events")).toBeDisabled();
		await userEvent.clear(within(retention).getByLabelText("Agent tool records"));
		await userEvent.type(within(retention).getByLabelText("Agent tool records"), "1d");
		await userEvent.click(within(retention).getByRole("button", { name: "Save" }));

		await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
		expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
			retention: { tasks: "30d", audit: "off", piTasks: "1d" },
		});
	});

	test("shows a server validation error inline beside the field", async () => {
		const api = mockApi();
		api.setPatchResponse(() =>
			json({ error: "invalid settings", fields: { publicUrl: "public_url must not have a query or fragment" } }, 400),
		);
		await renderPage();
		const general = section("general-section");

		await userEvent.type(within(general).getByLabelText("Public URL"), "https://crh.example.com/?x=1");
		await userEvent.click(within(general).getByRole("button", { name: "Save" }));

		expect(await within(general).findByText("public_url must not have a query or fragment")).toBeVisible();
	});

	test("saves only the Library defaults section's fields", async () => {
		const api = mockApi();
		await renderPage();
		const library = section("library-defaults-section");

		await userEvent.clear(within(library).getByLabelText("Files for new users"));
		await userEvent.type(within(library).getByLabelText("Files for new users"), "10");
		await userEvent.clear(within(library).getByLabelText("Files for new groups"));
		await userEvent.type(within(library).getByLabelText("Files for new groups"), "2");
		await userEvent.click(within(library).getByRole("button", { name: "Save" }));

		await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
		expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
			library: {
				user: { files: 10, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 },
				group: { files: 2, fileBytes: 0, totalBytes: 0 },
			},
		});
	});

	test("adds a signing key and shows its public key line to copy", async () => {
		const api = mockApi();
		await renderPage();

		await userEvent.click(screen.getByTestId("add-signing-key"));
		const dialog = await screen.findByRole("dialog", { name: "Add authorization signing key" });
		// There is nothing to fill in: a key is identified by its fingerprint.
		expect(within(dialog).queryByLabelText("Name")).not.toBeInTheDocument();
		await userEvent.click(within(dialog).getByRole("button", { name: "Add authorization signing key" }));

		const created = await screen.findByTestId("signing-key-created");
		expect(screen.getByRole("dialog", { name: "Authorization signing key added" })).toBeVisible();
		expect(within(created).getByText("ssh-ed25519 AAAANEWKEY crhs-signing")).toBeVisible();
		expect(within(created).getByText("SHA256:newest-key")).toBeVisible();
		expect(within(created).getByRole("button", { name: "Copy and close" })).toBeVisible();
		expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({});
		expect(api.state.keys[0]).not.toHaveProperty("name");
	});

	test("a delete blocked by a trusting node offers Delete anyway after a 409", async () => {
		const api = mockApi();
		api.setDeleteResponse((_id, body) =>
			body.force === true
				? null
				: json(
						{
							error: "1 node(s) still trust this key",
							nodes: [{ nodeId: "node-1", nodeName: "web-1", kinds: ["execute"] }],
						},
						409,
					),
		);
		await renderPage();

		await userEvent.click(
			await screen.findByRole("button", { name: "Delete authorization signing key SHA256:newest-key" }),
		);
		const dialog = await screen.findByRole("dialog", { name: "Delete authorization signing key?" });
		// The fingerprint wraps instead of widening the dialog, and a trusting node's link truncates.
		expect(within(dialog).getByText("SHA256:newest-key")).toHaveClass("break-all");
		expect(within(dialog).getByTestId("signing-key-trusted-nodes")).toHaveTextContent("web-1");
		await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

		expect(await screen.findByRole("dialog", { name: "Authorization signing key still trusted" })).toBeVisible();
		expect(screen.getByTestId("signing-key-trusted-nodes")).toHaveTextContent("web-1");
		await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		const deletes = api.calls.filter((call) => call.method === "DELETE");
		expect(deletes.map((call) => call.body)).toEqual([{}, { force: true }]);
		await waitFor(() => expect(screen.queryByText("SHA256:newest-key")).not.toBeInTheDocument());
	});

	test("a delete dialog lists at most three trusting nodes and summarises the rest", async () => {
		const many = {
			...NEWEST_KEY,
			id: "key-many",
			fingerprint: "SHA256:many-key",
			trustedBy: Array.from({ length: 5 }, (_, index) => ({
				nodeId: `node-${index + 1}`,
				nodeName: `node-${index + 1}`,
				kinds: ["execute" as const],
			})),
		};
		mockApi({ keys: [many] });
		await renderPage();

		await userEvent.click(
			await screen.findByRole("button", { name: "Delete authorization signing key SHA256:many-key" }),
		);
		const dialog = await screen.findByRole("dialog", { name: "Delete authorization signing key?" });
		const list = within(dialog).getByTestId("signing-key-trusted-nodes");
		expect(within(list).getAllByRole("link")).toHaveLength(3);
		expect(within(list).getByRole("link", { name: "node-1" })).toHaveClass("truncate");
		expect(within(list).getByRole("link", { name: "node-1" })).toHaveAttribute("title", "node-1");
		expect(within(list).queryByRole("link", { name: "node-4" })).not.toBeInTheDocument();
		expect(list).toHaveTextContent("and 2 more");
	});

	test("deleting the last key warns that crhs can no longer sign for any node", async () => {
		mockApi({ keys: [NEWEST_KEY] });
		await renderPage();

		await userEvent.click(
			await screen.findByRole("button", { name: "Delete authorization signing key SHA256:newest-key" }),
		);
		const dialog = await screen.findByRole("dialog", { name: "Delete authorization signing key?" });
		expect(
			within(dialog).getByText("This is the last authorization signing key: crhs will no longer sign for any node."),
		).toBeVisible();
	});
});
