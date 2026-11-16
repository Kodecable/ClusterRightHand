import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * The one session title the WebUI shows: the stored title, or the localized "New Session" for a null,
 * empty or whitespace-only one. Every list, breadcrumb and decision card reads the same fallback
 * (doc/design/webui.md "Shared components"); the server has the same helper for chat cards
 * (`displaySessionTitle` in server/src/channels/messages.ts).
 */
export function displaySessionTitle(title: string | null | undefined, i18n: I18n): string {
	if (title === null || title === undefined || title.trim() === "") return i18n._(msg`New Session`);
	return title;
}
