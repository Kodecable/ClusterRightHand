import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useVisualViewportHeight } from "./use-visual-viewport-height";

const APP_HEIGHT = "--app-height";

const originalViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
const originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");

function setWindowProperty(name: string, value: unknown): void {
	Object.defineProperty(window, name, { configurable: true, writable: true, value });
}

/** A visual viewport small enough to mean the keyboard covers part of the page. */
function installViewport(height: number, innerHeight = 800, offsetTop = 0, scale = 1) {
	const viewport = Object.assign(new EventTarget(), { height, offsetTop, scale });
	setWindowProperty("visualViewport", viewport);
	setWindowProperty("innerHeight", innerHeight);
	return viewport;
}

function setScrollY(value: number): void {
	Object.defineProperty(window, "scrollY", { configurable: true, get: () => value });
}

/** Let the hook's coalesced requestAnimationFrame run inside act. */
async function settle(): Promise<void> {
	await act(async () => {
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	});
}

function emit(viewport: EventTarget, type: "resize" | "scroll"): void {
	act(() => {
		viewport.dispatchEvent(new Event(type));
	});
}

function appHeight(): string {
	return document.documentElement.style.getPropertyValue(APP_HEIGHT);
}

afterEach(() => {
	for (const [name, descriptor] of [
		["visualViewport", originalViewport],
		["innerHeight", originalInnerHeight],
		["scrollY", originalScrollY],
	] as const) {
		if (descriptor === undefined) Reflect.deleteProperty(window, name);
		else Object.defineProperty(window, name, descriptor);
	}
});

describe("useVisualViewportHeight", () => {
	test("sets --app-height while the visual viewport is shorter than the window", async () => {
		installViewport(500.4, 800);
		renderHook(() => useVisualViewportHeight());
		await settle();
		expect(appHeight()).toBe("500px");
	});

	test("removes --app-height once the visual viewport is whole again", async () => {
		const viewport = installViewport(500, 800);
		renderHook(() => useVisualViewportHeight());
		await settle();
		expect(appHeight()).toBe("500px");

		viewport.height = 800;
		emit(viewport, "resize");
		await settle();
		expect(appHeight()).toBe("");
	});

	test("scrolls the page back to the top when it is panned", async () => {
		const viewport = installViewport(500, 800);
		const scrollTo = vi.mocked(window.scrollTo);
		scrollTo.mockClear();
		renderHook(() => useVisualViewportHeight());
		await settle();
		expect(scrollTo).not.toHaveBeenCalled();

		// A pan that moves the document.
		setScrollY(64);
		emit(viewport, "resize");
		await settle();
		expect(scrollTo).toHaveBeenLastCalledWith(0, 0);

		// A pan of the visual viewport alone.
		setScrollY(0);
		viewport.offsetTop = 48;
		scrollTo.mockClear();
		emit(viewport, "scroll");
		await settle();
		expect(scrollTo).toHaveBeenCalledWith(0, 0);
	});

	test("leaves a pinch zoom alone: no app height and no scroll back", async () => {
		const scrollTo = vi.fn();
		setWindowProperty("scrollTo", scrollTo);
		const viewport = installViewport(500, 800, 0, 1);
		renderHook(() => useVisualViewportHeight());
		await settle();
		expect(appHeight()).toBe("500px");

		// Zoomed in and panned: the visual viewport is small and offset, but no keyboard is involved.
		viewport.scale = 2;
		viewport.height = 400;
		viewport.offsetTop = 120;
		scrollTo.mockClear();
		emit(viewport, "scroll");
		await settle();
		expect(appHeight()).toBe("");
		expect(scrollTo).not.toHaveBeenCalled();
	});

	test("does nothing without a visual viewport", async () => {
		setWindowProperty("visualViewport", undefined);
		renderHook(() => useVisualViewportHeight());
		await settle();
		expect(appHeight()).toBe("");
	});

	test("removes the property and its listeners on unmount", async () => {
		const viewport = installViewport(500, 800);
		const { unmount } = renderHook(() => useVisualViewportHeight());
		await settle();
		expect(appHeight()).toBe("500px");

		unmount();
		expect(appHeight()).toBe("");

		viewport.height = 300;
		emit(viewport, "resize");
		await settle();
		expect(appHeight()).toBe("");
	});
});
