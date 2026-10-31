import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { isThemePreference, readThemePreference, ThemeProvider, useTheme } from "./theme";

function Probe() {
	const { preference, resolved, setPreference } = useTheme();
	return (
		<div>
			<span data-testid="preference">{preference}</span>
			<span data-testid="resolved">{resolved}</span>
			<button type="button" onClick={() => setPreference("light")}>
				light
			</button>
			<button type="button" onClick={() => setPreference("dark")}>
				dark
			</button>
			<button type="button" onClick={() => setPreference("system")}>
				system
			</button>
		</div>
	);
}

function setStored(value: string | null): void {
	if (value === null) window.localStorage.removeItem("crh.theme");
	else window.localStorage.setItem("crh.theme", value);
}

beforeEach(() => {
	setStored(null);
	window.localStorage.removeItem("crh.locale");
	document.documentElement.removeAttribute("data-theme");
});

describe("theme", () => {
	test("validates stored preferences", () => {
		expect(isThemePreference("dark")).toBe(true);
		expect(isThemePreference("light")).toBe(true);
		expect(isThemePreference("system")).toBe(true);
		expect(isThemePreference("blue")).toBe(false);
		expect(isThemePreference(null)).toBe(false);
	});

	test("defaults to system and paints the data-theme attribute", async () => {
		render(
			<ThemeProvider>
				<Probe />
			</ThemeProvider>,
		);
		expect(screen.getByTestId("preference")).toHaveTextContent("system");
		await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
	});

	test("switching to dark writes storage and the attribute", async () => {
		render(
			<ThemeProvider>
				<Probe />
			</ThemeProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "dark" }));
		expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
		expect(window.localStorage.getItem("crh.theme")).toBe("dark");
		await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
	});

	test("a stored preference wins at boot", async () => {
		setStored("dark");
		expect(readThemePreference()).toBe("dark");
		render(
			<ThemeProvider>
				<Probe />
			</ThemeProvider>,
		);
		expect(screen.getByTestId("preference")).toHaveTextContent("dark");
		await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
	});

	test("system follows matchMedia and stops listening when overridden", async () => {
		let listener: (() => void) | null = null;
		let dark = false;
		const media = {
			get matches() {
				return dark;
			},
			media: "(prefers-color-scheme: dark)",
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: (_: string, fn: () => void) => {
				listener = fn;
			},
			removeEventListener: () => {
				listener = null;
			},
			dispatchEvent: () => false,
		} as unknown as MediaQueryList;
		const original = window.matchMedia;
		window.matchMedia = () => media;
		try {
			render(
				<ThemeProvider>
					<Probe />
				</ThemeProvider>,
			);
			await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
			dark = true;
			act(() => listener?.());
			expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
			fireEvent.click(screen.getByRole("button", { name: "light" }));
			expect(listener).toBeNull();
		} finally {
			window.matchMedia = original;
		}
	});
});
