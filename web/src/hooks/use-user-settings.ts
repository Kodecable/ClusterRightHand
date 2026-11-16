import type { UserSettings, UserSettingsUpdate } from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { http } from "@/lib/api/client";
import { useLocale } from "@/lib/i18n";

/**
 * The signed-in user's own settings (doc/design/webui.md "Settings dialog"). They are shared by the shell's
 * language sync, the settings dialog, the chat account section and the new-session defaults, so they live in
 * the shared hooks layer rather than in one feature.
 */

export const userSettingsKey = ["user-settings"] as const;

export function useUserSettings() {
	return useQuery({
		queryKey: userSettingsKey,
		queryFn: ({ signal }) =>
			http.get<{ settings: UserSettings }>("/me/settings", { signal }).then((response) => response.settings),
	});
}

export function useSaveUserSettings() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: UserSettingsUpdate) =>
			http.patch<{ settings: UserSettings }>("/me/settings", body).then((response) => response.settings),
		onSuccess: (settings) => queryClient.setQueryData(userSettingsKey, settings),
	});
}

/**
 * The server's language wins after login: when it is set and differs, switch to it. When it is null, the
 * UI's stored/browser choice becomes the account's language: the shell PATCHes it once, so the settings
 * dialog does not show a language as saved when the server has none. A saved value is never overwritten, and
 * one failed write is not retried (the next sign-in tries again). Switching writes the `crh.locale` cache, so
 * the login page and the first paint use it next time.
 */
export function useServerLocaleSync(): void {
	const { data } = useUserSettings();
	const save = useSaveUserSettings();
	const { locale, setLocale, switching } = useLocale();
	const serverLocale = data?.locale ?? null;
	// One implicit write per mounted shell: a null that survives a failed PATCH must not loop.
	const writeBackAttempted = useRef(false);

	useEffect(() => {
		// Wait for the settings read: the initial undefined is not a null server value.
		if (data === undefined) return;
		if (serverLocale !== null) {
			if (!switching && serverLocale !== locale) setLocale(serverLocale);
			return;
		}
		if (switching || save.isPending || writeBackAttempted.current) return;
		writeBackAttempted.current = true;
		save.mutate({ locale });
	}, [data, serverLocale, locale, setLocale, switching, save]);
}
