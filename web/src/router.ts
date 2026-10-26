import { useEffect, useState } from "react";

/** Hash routing: "#/nodes/abc" -> ["nodes", "abc"]. */
export function parseHash(hash: string): string[] {
	return hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

export function useRoute(): string[] {
	const [route, setRoute] = useState(() => parseHash(location.hash));
	useEffect(() => {
		const on = () => setRoute(parseHash(location.hash));
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);
	return route;
}

export function navigate(path: string): void {
	location.hash = `#${path}`;
}
