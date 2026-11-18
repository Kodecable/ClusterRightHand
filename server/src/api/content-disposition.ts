/** `inline`/`attachment` with an ASCII fallback and the UTF-8 form for other file names. */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
	const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	const encoded = encodeURIComponent(filename).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
