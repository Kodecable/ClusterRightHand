import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the running crhs finds its documentation (doc/design/extensions.md "Documentation"). An unbundled
 * crhs reads the repository's `doc/` next to the server source; a release bundle carries the text files in
 * `doc/` next to `crhs.mjs`, like the bundled WebUI, so the tools always describe this version. Images are
 * neither copied nor read: the tools return text.
 */

// Set by the bundled build (scripts/build-crhs.ts); unbundled, it is not defined.
declare const __CRH_BUNDLED__: boolean | undefined;

/** The documentation directory of the running version. */
export function defaultDocsRoot(): string {
	if (typeof __CRH_BUNDLED__ !== "undefined" && __CRH_BUNDLED__) {
		return fileURLToPath(new URL("./doc", import.meta.url));
	}
	return fileURLToPath(new URL("../../../doc", import.meta.url));
}

/** The extensions `read_doc` can read: Markdown plus the configuration, script and data files beside it. */
const DOC_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".toml", ".yaml", ".yml", ".json", ".sh", ".txt", ".conf"]);

/** How much of a file is checked for NUL bytes before it is accepted as text. */
const NUL_CHECK_BYTES = 8 * 1024;

/** The text files under a directory, as forward-slash paths relative to it, sorted. */
export async function docFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				await walk(join(dir, entry.name), relative);
			} else if (entry.isFile() && DOC_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
				out.push(relative);
			}
		}
	};
	await walk(root, "");
	return out.sort();
}

/**
 * One documentation file's text, or undefined when the file is binary: a NUL byte in its first 8 KiB. The
 * extension says it may be documentation; this check keeps a mislabelled binary out of the tools.
 */
export async function readDocText(path: string): Promise<string | undefined> {
	const bytes = await readFile(path);
	if (bytes.subarray(0, NUL_CHECK_BYTES).includes(0)) return undefined;
	return bytes.toString("utf8");
}

/**
 * Copies the documentation text files into a bundle (scripts/build-crhs.ts), leaving images and other
 * binary files out. Returns the copied paths, relative to both roots, so a test can check the copy without
 * building a bundle.
 */
export async function copyDocFiles(sourceRoot: string, targetRoot: string): Promise<string[]> {
	const paths = await docFiles(sourceRoot);
	for (const path of paths) {
		const segments = path.split("/");
		const target = join(targetRoot, ...segments);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(join(sourceRoot, ...segments), target);
	}
	return paths;
}
