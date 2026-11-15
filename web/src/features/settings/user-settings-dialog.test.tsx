import type { UserSettings } from "@crh/api";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { UserSettingsDialog } from "./user-settings-dialog";

const SETTINGS: UserSettings = {
	locale: null,
	defaultModel: null,
	defaultRulePreset: null,
	showProgress: true,
	defaultChannelAccountId: null,
};

const MODELS = [
	{
		provider: "faux",
		providerName: "faux",
		modelId: "faux-1",
		name: "Faux One",
		contextWindow: 128_000,
		thinkingLevels: ["off", "high"],
		input: ["text"],
	},
];

interface Patch {
	path: string;
	body: Record<string, unknown>;
}

function mockApi(settings: UserSettings, patches: Patch[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
			if (url.pathname === "/api/me/settings") {
				if (init?.method === "PATCH") {
					const body = JSON.parse(String(init.body)) as Partial<UserSettings>;
					patches.push({ path: url.pathname, body });
					Object.assign(settings, body);
				}
				return json({ settings });
			}
			if (url.pathname === "/api/models") return json({ models: MODELS, sessionModel: null });
			if (url.pathname === "/api/channel-accounts") return json({ accounts: [], channels: [] });
			return json({ items: [], nextCursor: null });
		}),
	);
}

beforeEach(() => {
	localStorage.clear();
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("UserSettingsDialog", () => {
	test("renders General, Sessions and Chat sections", async () => {
		mockApi({ ...SETTINGS }, []);
		const user = userEvent.setup();
		renderWithI18n(<UserSettingsDialog open onOpenChange={() => {}} />);

		expect(await screen.findByTestId("user-settings-dialog")).toBeInTheDocument();
		expect(screen.getByTestId("settings-tab-general")).toBeInTheDocument();
		expect(screen.getByText("Language")).toBeInTheDocument();

		await user.click(screen.getByTestId("settings-tab-sessions"));
		expect(await screen.findByTestId("settings-default-model")).toBeInTheDocument();
		expect(screen.getByTestId("settings-default-rule-preset")).toBeInTheDocument();

		await user.click(screen.getByTestId("settings-tab-chat"));
		expect(await screen.findByTestId("chat-accounts")).toBeInTheDocument();
	});

	test("changing the language PATCHes the server and switches immediately", async () => {
		const patches: Patch[] = [];
		mockApi({ ...SETTINGS }, patches);
		const user = userEvent.setup();
		renderWithI18n(<UserSettingsDialog open onOpenChange={() => {}} />);

		await user.click(await screen.findByTestId("settings-language-zh"));
		await waitFor(() => expect(patches).toHaveLength(1));
		expect(patches[0]?.body).toEqual({ locale: "zh-CN" });
		await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
		expect(localStorage.getItem("crh.locale")).toBe("zh-CN");
		expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
	});
});
