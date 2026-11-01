const memory = new Map<string, string>();

/**
 * `localStorage` access that never throws.
 *
 * Storage is unavailable in some private modes and can be blocked by policy;
 * the UI must keep working without it. The in-memory fallback keeps a value for
 * the lifetime of the page so toggles do not snap back immediately.
 */
export function readStorage(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return memory.get(key) ?? null;
	}
}

export function writeStorage(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		memory.set(key, value);
	}
}
