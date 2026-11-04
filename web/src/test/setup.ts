import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
	cleanup();
});

// jsdom does not implement matchMedia, and the theme + sidebar use it.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
	window.matchMedia = (query: string) =>
		({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}) as unknown as MediaQueryList;
}

// Base UI's ScrollArea waits for a popup's exit animations; jsdom has none.
if (typeof Element !== "undefined" && typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}

// Base UI's popups and shadcn's sidebar measure elements.
if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
	window.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
}

// The data table's load-more sentinel guards on this; tests drive it explicitly.
if (typeof window !== "undefined" && typeof window.IntersectionObserver === "undefined") {
	window.IntersectionObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
		takeRecords() {
			return [];
		}
	} as unknown as typeof IntersectionObserver;
}

// Deterministic default: tests that need the OS dark preference override this.
if (typeof window !== "undefined") {
	Object.defineProperty(window, "scrollTo", { value: vi.fn(), writable: true });
}
