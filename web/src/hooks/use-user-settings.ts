import type { UserSettings, UserSettingsUpdate } from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
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
 * The server's language wins after login: when it is set and differs, switch to it. A null server value
 * leaves the stored/browser choice alone, and nothing is written back implicitly. Switching writes the
 * `crh.locale` cache, so the login page and the first paint use it next time.
 */
export function useServerLocaleSync(): void {
	const { data } = useUserSettings();
	const { locale, setLocale, switching } = useLocale();
	const serverLocale = data?.locale ?? null;

	useEffect(() => {
		if (serverLocale === null || switching || serverLocale === locale) return;
		setLocale(serverLocale);
	}, [serverLocale, locale, setLocale, switching]);
}
