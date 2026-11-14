import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the running crhs finds its documentation (doc/design/extensions.md "Documentation"). An unbundled
 * crhs reads the repository's `doc/` next to the server source; a release bundle carries the Markdown files
 * in `doc/` next to `crhs.mjs`, like the bundled WebUI, so the tools always describe this version. Images
 * are not copied: the tools return text.
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

/** The Markdown files under a directory, as forward-slash paths relative to it, sorted. */
export async function markdownDocs(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				await walk(join(dir, entry.name), relative);
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				out.push(relative);
			}
		}
	};
	await walk(root, "");
	return out.sort();
}

/**
 * Copies the Markdown documentation into a bundle (scripts/build-crhs.ts), leaving images out. Returns the
 * copied paths, relative to both roots, so a test can check the copy without building a bundle.
 */
export async function copyDocMarkdown(sourceRoot: string, targetRoot: string): Promise<string[]> {
	const paths = await markdownDocs(sourceRoot);
	for (const path of paths) {
		const segments = path.split("/");
		const target = join(targetRoot, ...segments);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(join(sourceRoot, ...segments), target);
	}
	return paths;
}
