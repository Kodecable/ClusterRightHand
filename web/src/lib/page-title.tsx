import { createContext, useContext, useEffect } from "react";
import { APP_NAME } from "./meta";

/**
 * How much of a command a browser tab and the shell's header bar show. The
 * page's own heading keeps the full text and its tooltip; the shell title only
 * needs enough to tell two tabs apart.
 */
const MAX_PAGE_TITLE = 80;

/** One line, at most {@link MAX_PAGE_TITLE} characters, with an ellipsis when cut. */
export function truncatePageTitle(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > MAX_PAGE_TITLE ? `${oneLine.slice(0, MAX_PAGE_TITLE - 1)}…` : oneLine;
}

type SetPageTitle = (title: string | undefined) => void;

const PageTitleContext = createContext<SetPageTitle | null>(null);

/** Provides the shell's title setter to the routed page. */
export function PageTitleProvider({ setTitle, children }: { setTitle: SetPageTitle; children: React.ReactNode }) {
	return <PageTitleContext.Provider value={setTitle}>{children}</PageTitleContext.Provider>;
}

/**
 * Titles the shell's header bar and the document with the object's own name
 * (a task's or task group's summary) instead of the navigation item. The full
 * heading and its tooltip stay on the page. Cleared when the page unmounts;
 * outside the shell (component tests) it falls back to setting the document
 * title, so a page can still be checked without the whole shell.
 */
export function usePageTitle(title: string | undefined): void {
	const setTitle = useContext(PageTitleContext);
	const next = title === undefined || title.trim() === "" ? undefined : truncatePageTitle(title);
	useEffect(() => {
		if (setTitle !== null) {
			setTitle(next);
			return () => setTitle(undefined);
		}
		if (next !== undefined) document.title = `${next} · ${APP_NAME}`;
	}, [next, setTitle]);
}
