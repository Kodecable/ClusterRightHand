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

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<LocaleProvider initialLocale="en">{children}</LocaleProvider>
		</QueryClientProvider>
	);
}

function mockSettings(settings: UserSettings): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ settings }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
}

beforeEach(() => {
	localStorage.clear();
	activateLocale("en");
});

describe("useServerLocaleSync", () => {
	test("switches to the server's language and caches it", async () => {
		mockSettings({ ...SETTINGS, locale: "zh-CN" });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		renderHook(() => useServerLocaleSync(), { wrapper: wrapper(client) });

		await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
		expect(localStorage.getItem("crh.locale")).toBe("zh-CN");
	});

	test("a null server value keeps the browser or stored choice and writes nothing", async () => {
		mockSettings({ ...SETTINGS, locale: null });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		renderHook(() => useServerLocaleSync(), { wrapper: wrapper(client) });

		await waitFor(() => expect(client.getQueryData(["user-settings"])).toBeDefined());
		expect(document.documentElement.lang).toBe("en");
		expect(localStorage.getItem("crh.locale")).toBeNull();
	});
});
