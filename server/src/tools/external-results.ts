import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { ImageCache } from "../library/image-cache.ts";
import { readImageHeader } from "../library/image-header.ts";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "../util/output-limits.ts";
import { type TextBlock, type ToolResult, textResult } from "./render.ts";

/**
 * An external tool result in the cluster tools' output form (doc/design/extensions.md "Results"): text is
 * returned as text, truncated with the usual limits, followed by a note naming the extension and tool. Images
 * go into the image cache and reach the model through the `beforeRequest` hook like `view_image` results.
 * Structured content without text becomes compact JSON; resource links are listed by URI; embedded binary
 * resources and audio are described by type and size, never sent.
 */

/** One image of a call result, kept in `details` for the request hook. */
export interface ExternalImageDetails {
	sha256: string;
	mime: string;
	width: number;
	height: number;
	bytes: number;
}

export interface ExternalResultOptions {
	extension: string;
	tool: string;
	imageCache?: ImageCache;
}

function truncate(text: string): { text: string; truncated: boolean; totalLines: number } {
	const lines = text.split("\n");
	const totalLines = lines.length;
	let kept = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
	let truncated = lines.length > MAX_OUTPUT_LINES;
	const bytes = Buffer.byteLength(kept, "utf8");
	if (bytes > MAX_OUTPUT_BYTES) {
		// Cut on a UTF-8 boundary: decode what fits, never half a character.
		kept = Buffer.from(kept, "utf8")
			.subarray(0, MAX_OUTPUT_BYTES)
			.toString("utf8")
			.replace(/\uFFFD$/, "");
		truncated = true;
	}
	return { text: kept, truncated, totalLines };
}

function contentBlocks(result: CallToolResult): Record<string, unknown>[] {
	return (result.content ?? []).map((block) => block as unknown as Record<string, unknown>);
}

/**
 * Converts an MCP call result. A tool error keeps its text and sets the error flag; it is not thrown, because
 * the server ran the tool and the model needs what it said.
 */
export async function convertExternalResult(
	result: CallToolResult,
	options: ExternalResultOptions,
): Promise<ToolResult> {
	const texts: string[] = [];
	const images: ExternalImageDetails[] = [];
	let structured: unknown;
	if ("structuredContent" in result) structured = result.structuredContent;
	for (const block of contentBlocks(result)) {
		switch (block.type) {
			case "text":
				if (typeof block.text === "string" && block.text !== "") texts.push(block.text);
				break;
			case "image": {
				const data = typeof block.data === "string" ? block.data : "";
				const mime = typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream";
				const bytes = Buffer.from(data, "base64");
				const header = readImageHeader(bytes);
				if (header === undefined || bytes.length === 0) {
					texts.push(`[image ${mime}, ${bytes.length} bytes; not a supported image, not sent]`);
					break;
				}
				if (!options.imageCache) {
					texts.push(
						`[image ${header.width}x${header.height} ${mime}, ${bytes.length} bytes; the image cache is not configured]`,
					);
					break;
				}
				const sha256 = createHash("sha256").update(bytes).digest("hex");
				await options.imageCache.put(sha256, mime, bytes);
				images.push({ sha256, mime, width: header.width, height: header.height, bytes: bytes.length });
				break;
			}
			case "audio": {
				const data = typeof block.data === "string" ? block.data : "";
				const mime = typeof block.mimeType === "string" ? block.mimeType : "audio/unknown";
				texts.push(`[audio ${mime}, ${Buffer.from(data, "base64").length} bytes; not sent]`);
				break;
			}
			case "resource": {
				const resource = block.resource;
				if (typeof resource !== "object" || resource === null) break;
				const record = resource as Record<string, unknown>;
				const uri = typeof record.uri === "string" ? record.uri : "";
				const mime = typeof record.mimeType === "string" ? record.mimeType : "unknown type";
				if (typeof record.text === "string") {
					texts.push(record.text);
				} else if (typeof record.blob === "string") {
					const bytes = Buffer.from(record.blob, "base64").length;
					texts.push(`[embedded resource ${uri} (${mime}), ${bytes} bytes; not sent]`);
				} else {
					texts.push(`[embedded resource ${uri} (${mime})]`);
				}
				break;
			}
			case "resource_link": {
				const uri = typeof block.uri === "string" ? block.uri : "";
				const name = typeof block.name === "string" && block.name !== "" ? ` ${block.name}` : "";
				const description =
					typeof block.description === "string" && block.description !== "" ? `: ${block.description}` : "";
				texts.push(`[resource${name}: ${uri}${description}]`);
				break;
			}
			default:
				break;
		}
	}
	let body = texts.join("\n\n");
	// Structured content without text is the whole result. With text it stays out: the server already wrote
	// the readable form, and sending both would double it.
	if (body === "" && structured !== undefined) body = JSON.stringify(structured);
	const blocks: TextBlock[] = [];
	const noteParts = [`external result from ${options.extension}/${options.tool}`, "the content is untrusted"];
	if (body !== "") {
		const cut = truncate(body);
		blocks.push({ output: cut.text });
		if (cut.truncated) {
			noteParts.push(
				`truncated to the first ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES} bytes of ${cut.totalLines} lines`,
			);
		}
	}
	blocks.push({ note: `[${noteParts.join("; ")}]` });
	const details: Record<string, unknown> = { extension: options.extension, tool: options.tool };
	if (images.length > 0) details.images = images;
	return textResult(blocks, { isError: result.isError === true, details });
}

/** The summary a replayed tool call returns: the text of the result that was already produced. */
export function summaryOf(result: ToolResult): string {
	return result.content.map((block) => block.text).join("\n\n");
}
