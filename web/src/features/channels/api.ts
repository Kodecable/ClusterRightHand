import type {
	AvailableModel,
	ChannelAccountListResponse,
	ChannelInput,
	ChannelLinkCodeResponse,
	ChannelSettings,
	ChannelSettingsUpdate,
	ChannelView,
} from "@crh/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http } from "@/lib/api/client";

export const channelKeys = {
	all: ["channels"] as const,
	list: () => ["channels", "list"] as const,
	accounts: () => ["channels", "accounts"] as const,
	settings: () => ["channels", "settings"] as const,
	models: () => ["channels", "models"] as const,
};

/** The models the server offers, for a channel's default. */
export function useAvailableModels() {
	return useQuery({
		queryKey: channelKeys.models(),
		queryFn: ({ signal }) => http.get<{ models: AvailableModel[] }>("/models", { signal }).then((r) => r.models),
		staleTime: 5 * 60_000,
	});
}

/** The administrator's channels (doc/design/channels.md "Channels"). */
export function useChannels() {
	return useQuery({
		queryKey: channelKeys.list(),
		queryFn: ({ signal }) => http.get<{ channels: ChannelView[] }>("/channels", { signal }).then((r) => r.channels),
		// The connection state and next attempt change in the background.
		refetchInterval: 5_000,
	});
}

export function useSaveChannel() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ name, body }: { name: string; body: ChannelInput }) =>
			http.put<{ channel: ChannelView }>(`/channels/${enc(name)}`, body).then((r) => r.channel),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: channelKeys.all }),
	});
}

export function useDeleteChannel() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => http.del<{ ok: true }>(`/channels/${enc(name)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: channelKeys.all }),
	});
}

/** The caller's linked chat accounts and the channels they may link on. */
export function useChannelAccounts() {
	return useQuery({
		queryKey: channelKeys.accounts(),
		queryFn: ({ signal }) => http.get<ChannelAccountListResponse>("/channel-accounts", { signal }),
	});
}

export function useCreateLinkCode() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (channelId?: string) =>
			http.post<ChannelLinkCodeResponse>("/channel-link-codes", channelId === undefined ? {} : { channelId }),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: channelKeys.accounts() }),
	});
}

export function useUnlinkAccount() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => http.del<{ ok: true }>(`/channel-accounts/${enc(id)}`),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: channelKeys.accounts() }),
	});
}

export function useChannelSettings() {
	return useQuery({
		queryKey: channelKeys.settings(),
		queryFn: ({ signal }) =>
			http.get<{ settings: ChannelSettings }>("/channel-settings", { signal }).then((r) => r.settings),
	});
}

export function useSaveChannelSettings() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: ChannelSettingsUpdate) =>
			http.put<{ settings: ChannelSettings }>("/channel-settings", body).then((r) => r.settings),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: channelKeys.settings() });
			void queryClient.invalidateQueries({ queryKey: channelKeys.accounts() });
		},
	});
}
