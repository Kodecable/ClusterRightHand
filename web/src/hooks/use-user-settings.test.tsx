import type { UserSettings } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n";
import { activateLocale } from "@/test/render";
import { useServerLocaleSync } from "./use-user-settings";

const SETTINGS: UserSettings = {
	locale: null,
	defaultModel: null,
	defaultRulePreset: null,
	showProgress: true,
	defaultChannelAccountId: null,
};

function wrapper(client: QueryClient, initialLocale: "en" | "zh-CN" = "en") {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<LocaleProvider initialLocale={initialLocale}>{children}</LocaleProvider>
		</QueryClientProvider>
	);
}

interface Call {
	method: string;
	body: unknown;
}

/**
 * Answer `GET /me/settings` with `settings` and `PATCH /me/settings` with the merged settings (or a failure),
 * recording every call so the tests can assert how often the implicit write happened.
 */
function mockSettings(settings: UserSettings, options: { patchStatus?: number } = {}): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
			calls.push({ method, body });
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), {
					status,
					headers: { "content-type": "application/json" },
				});
			if (method === "PATCH") {
				if (options.patchStatus !== undefined) return json({ error: "no" }, options.patchStatus);
				return json({ settings: { ...settings, ...(body as Partial<UserSettings>) } });
			}
			return json({ settings });
		}),
	);
	return calls;
}

const patches = (calls: Call[]) => calls.filter((call) => call.method === "PATCH");

beforeEach(() => {
	localStorage.clear();
	activateLocale("en");
});

describe("useServerLocaleSync", () => {
	test("switches to the server's language and caches it without writing the settings", async () => {
		const calls = mockSettings({ ...SETTINGS, locale: "zh-CN" });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		renderHook(() => useServerLocaleSync(), { wrapper: wrapper(client) });

		await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
		expect(localStorage.getItem("crh.locale")).toBe("zh-CN");
		expect(patches(calls)).toEqual([]);
	});

	test("a null server value writes the current UI language back exactly once", async () => {
		const calls = mockSettings({ ...SETTINGS, locale: null });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		renderHook(() => useServerLocaleSync(), { wrapper: wrapper(client) });

		await waitFor(() => expect(patches(calls)).toHaveLength(1));
		expect(patches(calls)[0]?.body).toEqual({ locale: "en" });
		// The PATCH response becomes the cache, so the saw-tooth null does not cause a second write.
		await waitFor(() => expect(client.getQueryData<UserSettings>(["user-settings"])?.locale).toBe("en"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(patches(calls)).toHaveLength(1);
		expect(document.documentElement.lang).toBe("en");
	});

	test("the write-back uses the stored/browser language, not always English", async () => {
		activateLocale("zh-CN");
		const calls = mockSettings({ ...SETTINGS, locale: null });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		renderHook(() => useServerLocaleSync(), { wrapper: wrapper(client, "zh-CN") });

		await waitFor(() => expect(patches(calls)).toHaveLength(1));
		expect(patches(calls)[0]?.body).toEqual({ locale: "zh-CN" });
	});

	test("a failed write is not retried in a loop", async () => {
		const calls = mockSettings({ ...SETTINGS, locale: null }, { patchStatus: 500 });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
		renderHook(() => useServerLocaleSync(), { wrapper: wrapper(client) });

		await waitFor(() => expect(patches(calls)).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(patches(calls)).toHaveLength(1);
	});
});
