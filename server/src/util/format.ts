/**
 * Human-readable formatting shared by the chat messages and the agent tools, so a byte count reads the
 * same wherever it is shown (doc/design/channels.md "Messages").
 */

/** A byte count the way the WebUI shows it: the largest binary unit, such as "32 MiB". */
export function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let amount = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
	let unit = 0;
	while (amount >= 1024 && unit < units.length - 1) {
		amount /= 1024;
		unit += 1;
	}
	return `${Number(amount.toFixed(unit === 0 ? 0 : 1))} ${units[unit]}`;
}
