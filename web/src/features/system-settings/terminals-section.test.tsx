import type { SystemSettings } from "@crh/api";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { TerminalsSection } from "./terminals-section";

function settings(overrides: Partial<SystemSettings["pty"]> = {}): SystemSettings {
	return {
		publicUrl: null,
		clockWarn: "60s",
		retention: { tasks: "90d", audit: "180d", piTasks: "7d" },
		webauthn: { rpId: null, rpName: "ClusterRightHand", origins: [] },
		auth: { captcha: "cap", argon2Concurrency: 2, argon2Queue: 32 },
		realIpHeader: null,
		library: {
			user: { files: 256, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 },
			userGroup: { files: 0, fileBytes: 0, totalBytes: 0 },
		},
		attachments: { inlineTextBytes: 32768, inlineTotalBytes: 65536 },
		imageCache: { diskBytes: 1073741824, ttl: "7d" },
		directoryCopy: { files: 256, bytes: 268435456 },
		skills: { maxPerUser: 64 },
		jobs: { maxConsecutiveWakes: 10, maxRunning: 32 },
		pty: {
			enabled: true,
			maxPerNode: 8,
			maxTotal: 64,
			maxPerSession: 4,
			agentIdleTimeoutMax: "1h",
			watchTimeoutMax: "10m",
			scrollbackBytes: 1024 * 1024,
			...overrides,
		},
	};
}

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function mockApi(patchResponse?: (body: Record<string, unknown>) => Response): { calls: Call[] } {
	const calls: Call[] = [];
	const current = settings();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			calls.push({ url, method, body });
			if (url === "/api/settings" && method === "PATCH") {
				if (patchResponse !== undefined) return patchResponse(body ?? {});
				const pty = (body?.pty ?? {}) as Partial<SystemSettings["pty"]>;
				return json({ settings: { ...current, pty: { ...current.pty, ...pty } } });
			}
			return json({});
		}),
	);
	return { calls };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("TerminalsSection", () => {
	test("saves the whole pty group in the API's field shape", async () => {
		const api = mockApi();
		renderWithI18n(<TerminalsSection settings={settings()} defaults={settings()} />);

		const perNode = screen.getByLabelText("Terminals per node");
		await userEvent.setup().clear(perNode);
		await userEvent.setup().type(perNode, "5");
		await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
		expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
			pty: {
				enabled: true,
				maxPerNode: 5,
				maxTotal: 64,
				maxPerSession: 4,
				agentIdleTimeoutMax: "1h",
				watchTimeoutMax: "10m",
				scrollbackBytes: 1024 * 1024,
			},
		});
	});

	test("maps a rejected field onto its input", async () => {
		const api = mockApi(() =>
			json({ error: "invalid settings", fields: { "pty.maxPerNode": "must be an integer >= 0" } }, 400),
		);
		renderWithI18n(<TerminalsSection settings={settings()} defaults={settings()} />);

		const total = screen.getByLabelText("Terminals in total");
		await userEvent.setup().clear(total);
		await userEvent.setup().type(total, "32");
		await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
		expect(await screen.findByText("must be an integer >= 0")).toBeVisible();
	});

	test("refuses a scrollback below crha's 64K minimum before sending", async () => {
		const api = mockApi();
		renderWithI18n(<TerminalsSection settings={settings()} defaults={settings()} />);

		const scrollback = screen.getByLabelText("Scrollback per terminal");
		await userEvent.setup().clear(scrollback);
		await userEvent.setup().type(scrollback, "1024");
		await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("Enter a size from 64K to 16M, such as 1M.")).toBeVisible();
		expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
	});
});
