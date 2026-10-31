import { Trans } from "@lingui/react/macro";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { activateLocale } from "@/test/render";
import { LocaleProvider, resolveInitialLocale, useLocale } from "./i18n";

function Probe() {
	const { locale, setLocale, switching } = useLocale();
	return (
		<div>
			<span data-testid="locale">{locale}</span>
			<span data-testid="switching">{String(switching)}</span>
			<p>
				<Trans>Theme</Trans>
			</p>
			<button type="button" onClick={() => setLocale("zh-CN")}>
				zh
			</button>
			<button type="button" onClick={() => setLocale("en")}>
				en
			</button>
		</div>
	);
}

function setLanguages(languages: readonly string[]): void {
	Object.defineProperty(window.navigator, "languages", { value: languages, configurable: true });
}

beforeEach(() => {
	window.localStorage.removeItem("crh.locale");
	setLanguages([]);
});

describe("resolveInitialLocale", () => {
	test("zh* navigator languages select zh-CN, everything else English", () => {
		setLanguages(["zh-CN", "en-US"]);
		expect(resolveInitialLocale()).toBe("zh-CN");
		setLanguages(["zh-Hans"]);
		expect(resolveInitialLocale()).toBe("zh-CN");
		setLanguages(["de-DE", "en"]);
		expect(resolveInitialLocale()).toBe("en");
	});

	test("a stored override wins", () => {
		setLanguages(["zh-CN"]);
		window.localStorage.setItem("crh.locale", "en");
		expect(resolveInitialLocale()).toBe("en");
		window.localStorage.setItem("crh.locale", "zh-CN");
		setLanguages(["en"]);
		expect(resolveInitialLocale()).toBe("zh-CN");
	});
});

describe("LocaleProvider", () => {
	test("switches the catalogue at runtime without remounting, and updates <html lang>", async () => {
		activateLocale("en");
		render(
			<LocaleProvider initialLocale="en">
				<Probe />
			</LocaleProvider>,
		);
		expect(screen.getByText("Theme")).toBeInTheDocument();
		expect(document.documentElement.lang).toBe("en");

		fireEvent.click(screen.getByRole("button", { name: "zh" }));
		await waitFor(() => expect(screen.getByText("主题")).toBeInTheDocument());
		expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(window.localStorage.getItem("crh.locale")).toBe("zh-CN");

		fireEvent.click(screen.getByRole("button", { name: "en" }));
		await waitFor(() => expect(screen.getByText("Theme")).toBeInTheDocument());
		expect(document.documentElement.lang).toBe("en");
	});
});
