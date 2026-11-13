/**
 * Per-conversation image rejection, derived from the transcript (doc/design/library.md "view_image").
 *
 * The transcript is the single source of truth: it follows conversation forks, needs no cleanup, and a
 * provider/model rejection belongs to one conversation rather than to the SHA-256 globally. A `view_image`
 * result whose request the provider answered with a 4xx twice is rejected for that conversation; a success
 * after it means the image did reach the provider and it is not rejected.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

/** An image is rejected after this many provider 4xx responses that follow its result without a success. */
const IMAGE_REJECTION_FAILURES = 2;

/** The structured `details.image` of a tool result, or undefined when it is missing or malformed. */
export function imageDetails(details: unknown): { sha256: string; mime: string; source: unknown } | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const image = (details as Record<string, unknown>).image;
	if (typeof image !== "object" || image === null) return undefined;
	const record = image as Record<string, unknown>;
	if (typeof record.sha256 !== "string" || typeof record.mime !== "string") return undefined;
	return { sha256: record.sha256, mime: record.mime, source: record.source };
}

/** The HTTP status a provider error carries, from pi-ai's diagnostics or the error's leading status. */
function providerErrorStatus(message: AssistantMessage): number | undefined {
	for (const diagnostic of message.diagnostics ?? []) {
		if (typeof diagnostic.error?.code === "number") return diagnostic.error.code;
		const details = diagnostic.details;
		const status = details?.status ?? details?.statusCode;
		if (typeof status === "number") return status;
	}
	const match = /^(?:(\d{3})(?::|\s)|[^:\n]*\((\d{3})\):)/.exec(message.errorMessage ?? "");
	return match ? Number(match[1] ?? match[2]) : undefined;
}

/** Whether the provider rejected the request with a 4xx; the wording of the error does not matter. */
function isProviderClientError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const status = providerErrorStatus(message);
	return status !== undefined && status >= 400 && status < 500;
}

/** Whether a successful assistant message follows this result before two provider 4xx responses do. */
function rejectedAfter(entries: readonly EntryRecord[], resultIndex: number): boolean {
	let failures = 0;
	for (let index = resultIndex + 1; index < entries.length; index++) {
		for (const message of entries[index]?.model ?? []) {
			if (message.role !== "assistant") continue;
			// Aborted is an error-like end: it is not a successful send and carries no provider 4xx.
			if (message.stopReason !== "error" && message.stopReason !== "aborted") return false;
			if (!isProviderClientError(message)) continue;
			failures += 1;
			if (failures >= IMAGE_REJECTION_FAILURES) return true;
		}
	}
	return false;
}

/**
 * The SHA-256s the provider rejected in this conversation. Each `view_image` result is judged from the
 * assistant messages after it; once one result of a SHA-256 is rejected, a later result is rejected too.
 */
export function rejectedImageSha256s(entries: readonly EntryRecord[]): ReadonlySet<string> {
	const rejected = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		for (const message of entries[index]?.model ?? []) {
			if (message.role !== "toolResult" || message.toolName !== "view_image") continue;
			const image = imageDetails(message.details);
			if (image === undefined || rejected.has(image.sha256)) continue;
			if (rejectedAfter(entries, index)) rejected.add(image.sha256);
		}
	}
	return rejected;
}
