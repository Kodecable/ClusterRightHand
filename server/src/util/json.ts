/** A stored JSON column, or null when it is absent or unreadable. */
export function parseJson<T>(raw: string | null): T | null {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}
