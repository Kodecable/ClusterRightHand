import { enc, queryString } from "@/lib/api/client";

/** The download and image-preview URLs of one file, as the browser fetches them with the session cookie. */
export interface FileUrls {
	download: string;
	preview: string;
}

/** A library file by its `user:<name>` / `user_group:<name>` reference and library path. */
export function libraryFileUrls(ref: string, path: string): FileUrls {
	const base = `/api/libraries/${enc(ref)}/file`;
	return { download: `${base}${queryString({ path })}`, preview: `${base}${queryString({ path, preview: "1" })}` };
}

/** A node file by its node id and absolute path; the download runs a `file.pull` as the signed-in user. */
export function nodeFileUrls(nodeId: string, path: string): FileUrls {
	const base = `/api/nodes/${enc(nodeId)}/file`;
	return { download: `${base}${queryString({ path })}`, preview: `${base}${queryString({ path, preview: "1" })}` };
}

/**
 * Starts a browser download of a same-origin URL without leaving the page: a `download` link answers a
 * failure as a failed download instead of navigating to the error body. Tests replace it.
 */
export function startDownload(url: string, name: string): void {
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.rel = "noopener";
	link.style.display = "none";
	document.body.append(link);
	link.click();
	link.remove();
}
