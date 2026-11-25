import type { SystemSettings } from "@crh/api";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { MetricsSection } from "./metrics-section";

function settings(overrides: Partial<SystemSettings["metrics"]> = {}): SystemSettings {
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
		},
		metrics: {
			enabled: true,
			interval: 60,
			retention: { l1: "24h", l2: "7d", l3: "30d", l4: "365d" },
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
				const metrics = (body?.metrics ?? {}) as Partial<SystemSettings["metrics"]>;
				return json({
					settings: {
						...current,
						metrics: {
							...current.metrics,
							...metrics,
							retention: { ...current.metrics.retention, ...(metrics.retention ?? {}) },
						},
					},
				});
			}
			return json({});
		}),
	);
	return { calls };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("MetricsSection", () => {
	test("offers exactly the accepted sample intervals", async () => {
		mockApi();
		renderWithI18n(<MetricsSection settings={settings()} defaults={settings()} />);

		await userEvent.setup().click(screen.getByRole("combobox", { name: "Sample interval" }));
		const options = await screen.findAllByRole("option");
		expect(options.map((option) => option.textContent?.trim())).toEqual([
			"15 seconds",
			"20 seconds",
			"30 seconds",
			"60 seconds",
		]);
	});

	test("saves the metrics group with its interval and retention", async () => {
		const api = mockApi();
		renderWithI18n(<MetricsSection settings={settings()} defaults={settings()} />);

		const l1 = screen.getByLabelText("Keep 1-minute buckets");
		await userEvent.setup().clear(l1);
		await userEvent.setup().type(l1, "48h");
		await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
		expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
			metrics: {
				enabled: true,
				interval: 60,
				retention: { l1: "48h", l2: "7d", l3: "30d", l4: "365d" },
			},
		});
	});

	test("maps the server's level-order rejection onto the later field", async () => {
		const api = mockApi(() =>
			json(
				{
					error: "invalid settings",
					fields: { "metrics.retention.l2": "metrics.retention.l2 must be at least metrics.retention.l1" },
				},
				400,
			),
		);
		renderWithI18n(<MetricsSection settings={settings()} defaults={settings()} />);

		const l2 = screen.getByLabelText("Keep 5-minute buckets");
		await userEvent.setup().clear(l2);
		await userEvent.setup().type(l2, "1h");
		await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
		expect(await screen.findByText("metrics.retention.l2 must be at least metrics.retention.l1")).toBeVisible();
	});

	test("refuses a malformed duration before sending", async () => {
		const api = mockApi();
		renderWithI18n(<MetricsSection settings={settings()} defaults={settings()} />);

		const l1 = screen.getByLabelText("Keep 1-minute buckets");
		await userEvent.setup().clear(l1);
		await userEvent.setup().type(l1, "soon");
		await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("Enter a duration such as 24h or 7d.")).toBeVisible();
		expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
	});
});
