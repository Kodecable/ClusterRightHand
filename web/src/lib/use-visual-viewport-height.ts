import { useEffect } from "react";

const APP_HEIGHT_PROPERTY = "--app-height";

/**
 * Keeps the app exactly as tall as the visual viewport on browsers that only
 * shrink the visual viewport for the on-screen keyboard (iOS Safari, older
 * Firefox Android) instead of resizing the layout viewport. Those browsers can
 * otherwise leave the document panned, exposing blank space below the status bar.
 *
 * The shell and the pages outside it mount this hook once. It is a no-op where
 * `window.visualViewport` does not exist.
 */
export function useVisualViewportHeight(): void {
	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		let frame: number | null = null;

		const apply = () => {
			frame = null;
			const root = document.documentElement;
			// A pinch zoom also makes the visual viewport smaller than the page; that is the
			// reader looking closer, not a keyboard, so the layout and the panning are left alone.
			if (viewport.scale > 1.01) {
				root.style.removeProperty(APP_HEIGHT_PROPERTY);
				return;
			}
			if (viewport.height < window.innerHeight - 1) {
				root.style.setProperty(APP_HEIGHT_PROPERTY, `${Math.round(viewport.height)}px`);
			} else {
				root.style.removeProperty(APP_HEIGHT_PROPERTY);
			}
			// The keyboard may also leave the layout viewport panned; only the page
			// moves back, so the transcript keeps its own scroll position.
			if (window.scrollY !== 0 || viewport.offsetTop > 0) window.scrollTo(0, 0);
		};

		// Resize and scroll can arrive together while the keyboard animates.
		const schedule = () => {
			if (frame !== null) return;
			frame = requestAnimationFrame(apply);
		};

		viewport.addEventListener("resize", schedule);
		viewport.addEventListener("scroll", schedule);
		schedule();

		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
			viewport.removeEventListener("resize", schedule);
			viewport.removeEventListener("scroll", schedule);
			document.documentElement.style.removeProperty(APP_HEIGHT_PROPERTY);
		};
	}, []);
}
