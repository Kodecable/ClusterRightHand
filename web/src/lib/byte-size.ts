/**
 * Byte sizes typed by people: `1048576`, `1M`, `1.5G`, `1 MiB` or `2T`. Every unit is base 1024,
 * so `1M`, `1MB` and `1MiB` all mean the same thing.
 */

const BYTE_SIZE = /^(\d+(?:\.\d+)?)\s*([kmgt]i?b?|b)?$/i;

/** The byte count `text` names, or undefined when it is not a size. */
export function parseByteSize(text: string): number | undefined {
	const match = BYTE_SIZE.exec(text.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = (match[2] ?? "").toUpperCase();
	const factor = unit === "" || unit === "B" ? 1 : 1024 ** ("KMGT".indexOf(unit[0] ?? "") + 1);
	const bytes = Math.round(amount * factor);
	return Number.isFinite(bytes) ? bytes : undefined;
}

const FORMAT_UNITS = [
	["TiB", 1024 ** 4],
	["GiB", 1024 ** 3],
	["MiB", 1024 ** 2],
	["KiB", 1024],
] as const;

/** The largest whole unit that divides `bytes`, or the raw byte count. */
export function formatByteSize(bytes: number): string {
	if (bytes === 0) return "0";
	for (const [unit, size] of FORMAT_UNITS) {
		if (bytes % size === 0) return `${bytes / size} ${unit}`;
	}
	return String(bytes);
}
