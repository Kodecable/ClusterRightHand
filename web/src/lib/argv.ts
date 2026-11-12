/**
 * Splits a command line into argv: whitespace separated, with single/double
 * quotes and backslash escapes. Used by the task form's "argv" mode.
 */
export function splitArgv(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	let has = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i] as string;
		if (quote) {
			if (char === quote) quote = null;
			else if (char === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
			else current += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			has = true;
		} else if (char === "\\" && i + 1 < line.length) {
			current += line[++i];
			has = true;
		} else if (/\s/.test(char)) {
			if (has || current) out.push(current);
			current = "";
			has = false;
		} else {
			current += char;
		}
	}
	if (has || current) out.push(current);
	return out;
}
